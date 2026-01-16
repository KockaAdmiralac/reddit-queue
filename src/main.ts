import {
    AutomoderatorFilterComment,
    AutomoderatorFilterPost,
    CommentReport,
    PostReport
} from '@devvit/protos';
import {Comment, Devvit, Post, TriggerContext} from '@devvit/public-api';

const WEBHOOK_URL_OPTION = 'webhookUrl';
const REDIS_HASH_KEY = 'modQueue';
const REDIS_UPDATE_KEY = 'needsUpdate';

Devvit.configure({
    // For sending HTTP requests to Discord.
    http: true,
    // For accessing the subreddit mod queue.
    redditAPI: true,
    // For storing sent message IDs.
    redis: true,
});

Devvit.addSchedulerJob({
    name: 'refreshQueue',
    onRun: refreshQueue,
});

Devvit.addTrigger({
    events: ['AppInstall', 'AppUpgrade'],
    onEvent: setupJobs,
});

Devvit.addTrigger({
    events: ['AutomoderatorFilterComment', 'CommentReport'],
    onEvent: handleComment,
})

Devvit.addTrigger({
    events: ['AutomoderatorFilterPost', 'CommentReport'],
    onEvent: handlePost,
});

Devvit.addSettings([
    {
        label: 'Discord webhook URL',
        helpText: 'The Discord webhook URL where mod queue items will be sent. Read more about how to create a webhook on https://support.discord.com/hc/articles/228383668.',
        name: WEBHOOK_URL_OPTION,
        type: 'string',
        onValidate: event => {
            if (!event.value) {
                return 'Please enter a value.';
            }
            if (!event.value.match(/^https:\/\/((?:canary|ptb)\.)?discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/)) {
                return 'Please enter a valid Discord webhook URL.';
            }
        }
    }
]);

// NOTE: Instead of failing by setting the Response.ok property, Devvit's
// fetch function instead throws an exception.
interface FetchError {
    // All details of the HTTP error in string format
    details: string;
}

/**
 * Sets up the scheduled job for updating the Discord messages to run every 30
 * seconds.
 * @param _ Unused
 * @param context Context in which the event is being invoked
 */
async function setupJobs(_: any, context: TriggerContext): Promise<void> {
    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));
    if (typeof await context.settings.get(WEBHOOK_URL_OPTION) !== 'string') {
        console.error('Webhook URL misconfigured, not scheduling jobs.');
        return;
    }
    await context.scheduler.runJob({
        name: 'refreshQueue',
        cron: '*/30 * * * * *',
    });
}

/**
 * Handles errors received from the Discord API, if Devvit had followed the
 * Fetch API. Since it doesn't, this method is likely left unused.
 * @param message Message to emit when a Discord request error occurs
 * @param response Response from the Discord API
 * @returns false if ratelimited, true otherwise
 */
async function handleDiscordErrorFetch(message: string, response: Response): Promise<boolean> {
    if (response.status === 429) {
        console.warn('Discord rate limit hit, skipping log.');
        return false;
    }
    console.error(message, {
        body: await response.text(),
        status: response.status,
        statusText: response.statusText,
    });
    return true;
}

/**
 * Handles errors received from the Discord API, given a httpbp.ClientError
 * object that only contains the HTTP status code within a "details" string,
 * because Devvit does not follow the Fetch API.
 * @param message Message to emit when a Discord request error occurs
 * @param response Response from the Discord API
 * @returns false if ratelimited, true otherwise
 */
async function handleDiscordErrorDevvit(message: string, error: FetchError): Promise<boolean> {
    if (error.details.includes('http status 429')) {
        console.warn('Discord rate limit hit, skipping log.');
        return false;
    }
    console.error(message, error);
    return true;
}

interface UpdateInfo {
    reason?: string;
    removed?: boolean;
}

/**
 * Queues an item to have its properties updated in the Discord channel.
 * @param id Item ID
 * @param update Properties that need updating
 * @param context Context in which the event is being invoked
 */
async function queueNeedsUpdate(id: string, update: UpdateInfo, context: TriggerContext): Promise<void> {
    await context.redis.hSet(REDIS_UPDATE_KEY, {
        [`${id}:${Date.now()}`]: JSON.stringify(update),
    });
}

/**
 * Gets a list of reasons why a an item is in the mod queue.
 * @param item Current mod queue item
 * @returns List of reasons why the item is in queue
 */
function getReasons(item: Post | Comment, updates: UpdateInfo[]): string[] {
    // NOTE: Reddit, through the Devvit API, does not provide which moderators
    // reported the item, unlike the old Data API which does.
    const reasons = item.modReportReasons
        .map(reason => `Mod report: ${reason}`)
        .concat(updates
            .map(update => update.reason)
            .filter((reason): reason is string => Boolean(reason))
        );
    if (item instanceof Post) {
        switch (item.removedByCategory) {
            case 'anti_evil_ops':
                reasons.push('Removed by Anti-Evil Ops');
                break;
            case 'community_ops':
                reasons.push('Removed by Community Ops');
                break;
            case 'content_takedown':
                reasons.push('Content takedown');
                break;
            case 'copyright_takedown':
                reasons.push('Copyright takedown');
                break;
            case 'reddit':
                reasons.push('Removed by Reddit');
                break;
            case 'automod_filtered':
                // Handled by separate events below.
                break;
            case undefined:
                // Not removed.
                break;
            case 'author':
                reasons.push('Removed by author. Why is this in the queue?');
                break;
            case 'deleted':
                reasons.push('Deleted by author. Why is this in the queue?');
                break;
            case 'moderator':
                reasons.push('Removed by moderator. Why is this in the queue?');
                break;
            default:
                reasons.push(`Unknown removal category: ${item.removedByCategory}`);
                break;
        }
    }
    if (item.spam) {
        reasons.push('Marked as spam');
    }
    if (item instanceof Comment) {
        if (item.collapsedBecauseCrowdControl) {
            // NOTE: Reddit does not let you know whether posts are filtered due
            // to crowd control, only comments.
            reasons.push('Crowd Control');
        }
    }
    return reasons;
}

interface EmbedMedia {
    url: string;
    height?: number;
    width?: number;
}

/**
 * Formats media inside a mod queue item for Discord embedding.
 * @param item Current mod queue item
 * @returns Image or video embed object to send to Discord
 */
function getMedia(item: Post | Comment): ['image' | 'video', EmbedMedia | undefined] {
    if (!(item instanceof Post)) {
        return ['image', undefined];
    }
    // NOTE: oEmbed most likely does not generate at the time the item is
    // queued, so Reddit never supplies us with this property.
    if (item.secureMedia?.oembed?.thumbnailUrl) {
        return ['image', {
            url: item.secureMedia.oembed.thumbnailUrl,
            height: item.secureMedia.oembed.thumbnailHeight,
            width: item.secureMedia.oembed.thumbnailWidth,
        }];
    }
    if (item.secureMedia?.redditVideo?.scrubberMediaUrl) {
        return ['video', {
            url: item.secureMedia.redditVideo.scrubberMediaUrl,
            height: item.secureMedia.redditVideo.height,
            width: item.secureMedia.redditVideo.width,
        }];
    }
    if (item.gallery.length > 0) {
        return ['image', item.gallery[0]];
    }
    return ['image', undefined];
}

/**
 * Formats a mod queue item into a Discord embed to send in the channel.
 * @param item Current mod queue item
 * @returns Embed to send in the channel for the current mod queue item
 */
async function getDiscordEmbed(item: Post | Comment, updates: UpdateInfo[]): Promise<any> {
    const author = await item.getAuthor();
    const username = author ? author.username : '[deleted]';
    const [mediaType, media] = getMedia(item);
    return {
        author: {
            name: `u/${username}`.slice(0, 256),
            url: author?.url,
            // NOTE: Reddit does not provide a way to get custom avatar images,
            // only Snoovatars.
            icon_url: await author?.getSnoovatarUrl(),
        },
        // NOTE: item.removed is false when the item has been filtered by
        // automod, which is why we have to check the event data.
        color: (item.removed || updates.some(u => u.removed)) ?
            0xFF0000 :
            0xFFA500,
        fields: Object.entries({
            'Reasons': getReasons(item, updates)
                .map(reason => `- ${reason}`)
                .join('\n'),
            'Content': item.body,
        })
            .filter(([, value]) => Boolean(value))
            .map(([name, value]) => ({
                name: name.slice(0, 256),
                value: (value as string).slice(0, 1024),
            })),
        title: (
            item instanceof Post ?
                item.title :
                `Comment by u/${username}`
        ).slice(0, 256),
        url: `https://www.reddit.com${item.permalink}`,
        [mediaType]: media,
    };
}

/**
 * Sends a mod queue item through the Discord webhook.
 * @param item Current mod queue item
 * @param webhookUrl Webhook URL to send the item through
 * @param sentMessages Mapping of item IDs to Discord sent message IDs
 * @returns false if ratelimited, true otherwise
 */
async function sendItem(
    item: Post | Comment,
    updates: UpdateInfo[],
    webhookUrl: string,
    sentMessages: Record<string, string>
): Promise<boolean> {
    const errorText = 'Failed to send webhook message!';
    try {
        const response = await fetch(`${webhookUrl}?wait=true`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [await getDiscordEmbed(item, updates)],
            }),
        });
        if (!response.ok) {
            // NOTE: This will not execute because Devvit's Fetch API does not
            // follow the standard.
            return handleDiscordErrorFetch(errorText, response);
        }
        const responseData = await response.json();
        const messageId = responseData.id as string;
        sentMessages[item.id] = messageId;
        console.debug(`Sent message ${messageId} for item ${item.id}.`);
        return true;
    } catch (error: any) {
        return handleDiscordErrorDevvit(errorText, error);
    }
}

/**
 * Removes a mod queue item from the Discord channel after it has been resolved.
 * @param id Mod queue item ID
 * @param webhookUrl Webhook URL previously used to send the item
 * @param context Context in which the event is being invoked
 * @returns false if ratelimited, true otherwise
 */
async function removeItem(id: string, webhookUrl: string, context: TriggerContext): Promise<boolean> {
    const messageId = await context.redis.hGet(REDIS_HASH_KEY, id);
    if (!messageId) {
        console.error(`No message ID found in Redis for resolved item ${id}.`);
        return true;
    }
    const errorText = 'Failed to delete webhook message!';
    try {
        const response = await fetch(`${webhookUrl}/messages/${messageId}`, {
            method: 'DELETE',
        });
        console.debug(`Deleted message ${messageId} for resolved item ${id}.`);
        if (!response.ok && response.status !== 404) {
            // NOTE: This will not execute because Devvit's Fetch API does not
            // follow the standard.
            return handleDiscordErrorFetch(errorText, response);
        }
        return true;
    } catch (error: any) {
        if (
            error &&
            typeof error.details === 'string' &&
            error.details.includes('http status 404')
        ) {
            // The message was already deleted, likely by a moderator of the
            // server.
            return true;
        } else {
            return handleDiscordErrorDevvit(errorText, error);
        }
    }
}

/**
 * Updates a mod queue item in the Discord channel after its properties have
 * changed.
 * @param id Mod queue item ID
 * @param updates Updates to be performed on the item
 * @param webhookUrl Webhook URL previously used to send the item
 * @param context Context in which the event is being invoked
 * @returns false if ratelimited, true otherwise
 */
async function updateItem(
    id: string,
    updates: UpdateInfo[],
    webhookUrl: string,
    context: TriggerContext
): Promise<boolean> {
    const messageId = await context.redis.hGet(REDIS_HASH_KEY, id);
    if (!messageId) {
        console.error(`No message ID found in Redis for updated item ${id}.`);
        return true;
    }
    const errorTextGet = 'Failed to get existing webhook message!';
    const errorTextUpdate = 'Failed to update webhook message!';
    let messageData: any = null;
    try {
        const getMessageResponse = await fetch(`${webhookUrl}/messages/${messageId}`);
        if (getMessageResponse.status === 404) {
            // The message was already deleted, likely by a moderator of the
            // server.
            return true;
        }
        if (!getMessageResponse.ok) {
            // NOTE: This will not execute because Devvit's Fetch API does not
            // follow the standard.
            return handleDiscordErrorFetch(errorTextGet, getMessageResponse);
        }
        messageData = await getMessageResponse.json();
    } catch (error: any) {
        if (
            error &&
            typeof error.details === 'string' &&
            error.details.includes('http status 404')
        ) {
            // The message was already deleted, likely by a moderator of the
            // server.
            return true;
        } else {
            return handleDiscordErrorDevvit(errorTextGet, error);
        }
    }
    if (!messageData.embeds || messageData.embeds.length === 0) {
        console.error(`No embeds found in existing webhook message for updated item ${id}.`);
        return true;
    }
    const embed = messageData.embeds[0];
    if (updates.some(update => update.removed)) {
        embed.color = 0xFF0000;
    }
    const reasons = embed.fields.find((field: any) => field.name === 'Reasons');
    const newReasons = updates
        .map(update => update.reason)
        .filter(Boolean)
        .map(reason => `- ${reason}`)
        .join('\n');
    if (reasons) {
        reasons.value = `${reasons.value}\n${newReasons}`.slice(0, 1024);
    } else {
        embed.fields.push({
            name: 'Reasons',
            value: newReasons.slice(0, 1024),
        });
    }
    try {
        const response = await fetch(`${webhookUrl}/messages/${messageId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [embed],
            }),
        });
        if (!response.ok) {
            return handleDiscordErrorFetch(errorTextUpdate, response);
        }
    } catch (error: any) {
        return handleDiscordErrorDevvit(errorTextUpdate, error);
    }
    console.debug(`Updated message ${messageId} for item ${id}.`);
    return true;
}

/**
 * Check the mod queue for new or resolved items and updates messages in the
 * Discord channel accordingly.
 * @param _ Unused
 * @param context Context in which the event is being invoked
 */
async function refreshQueue(_: any, context: TriggerContext): Promise<void> {
    const webhookUrl = await context.settings.get(WEBHOOK_URL_OPTION);
    if (typeof webhookUrl !== 'string') {
        return;
    }
    const subreddit = await context.reddit.getCurrentSubreddit();
    const alreadySentIds = await context.redis.hKeys(REDIS_HASH_KEY);
    const alreadySentIdsSet = new Set(alreadySentIds);
    const modQueue = await subreddit.getModQueue({
        limit: 1000,
        type: 'all',
    }).all();
    const currentIdsSet = new Set<string>(modQueue.map(item => item.id));
    const updates: ({id: string; key: string} & UpdateInfo)[] = Object.entries(
        await context.redis.hGetAll(REDIS_UPDATE_KEY)
    ).map(([compositeKey, value]) => ({
        id: compositeKey.split(':')[0],
        key: compositeKey,
        ...JSON.parse(value),
    }));
    const rejectedUpdates = updates.filter(update => !currentIdsSet.has(update.id));
    if (rejectedUpdates.length > 0) {
        console.info('Updates received for resolved items:', rejectedUpdates);
    }
    const sentMessages: Record<string, string> = {};
    const sentUpdateKeys = rejectedUpdates.map(update => update.key);
    for (const item of modQueue.filter(item => !alreadySentIdsSet.has(item.id))) {
        const itemUpdates = updates.filter(update => update.id === item.id);
        if (!await sendItem(item, itemUpdates, webhookUrl, sentMessages)) {
            // Discord ratelimited us.
            break;
        }
        sentUpdateKeys.push(...itemUpdates.map(update => update.key));
    }
    const resolvedIds = alreadySentIds.filter(id => !currentIdsSet.has(id));
    for (const id of resolvedIds) {
        if (!await removeItem(id, webhookUrl, context)) {
            // Discord ratelimited us.
            break;
        }
    }
    const alreadySentUpdates = updates.filter(update =>
        alreadySentIdsSet.has(update.id) &&
        currentIdsSet.has(update.id)
    ).reduce((acc, update) => {
        acc[update.id] = [...acc[update.id], update];
        return acc;
    }, {} as Record<string, ({key: string} & UpdateInfo)[]>);
    for (const [id, itemUpdates] of Object.entries(alreadySentUpdates)) {
        if (!await updateItem(id, itemUpdates, webhookUrl, context)) {
            // Discord ratelimited us.
            break;
        }
        sentUpdateKeys.push(...itemUpdates.map(update => update.key));
    }
    if (Object.keys(sentMessages).length > 0) {
        await context.redis.hSet(REDIS_HASH_KEY, sentMessages);
    }
    if (resolvedIds.length > 0) {
        await context.redis.hDel(REDIS_HASH_KEY, resolvedIds);
    }
    if (sentUpdateKeys.length > 0) {
        await context.redis.hDel(REDIS_UPDATE_KEY, sentUpdateKeys);
    }
}

/**
 * Receives AutoModerator comment filter and comment report events and queues
 * the comment to have its properties updated in the Discord channel.
 * @param event Filter or report event data
 * @param context Context in which the event is being invoked
 */
async function handleComment(
    event: AutomoderatorFilterComment | CommentReport,
    context: TriggerContext
): Promise<void> {
    if (!event.comment) {
        return;
    }
    const isFilter = 'removedAt' in event;
    const reason = isFilter ? 'Filtered by AutoModerator' : 'User report';
    await queueNeedsUpdate(event.comment.id, {
        reason: `${reason}: ${event.reason}`,
        removed: isFilter ? true : undefined,
    }, context);
}

/**
 * Receives AutoModerator post filter and post report events and queues
 * the post to have its properties updated in the Discord channel.
 * @param event Filter or report event data
 * @param context Context in which the event is being invoked
 */
async function handlePost(
    event: AutomoderatorFilterPost | PostReport,
    context: TriggerContext
): Promise<void> {
    if (!event.post) {
        return;
    }
    const isFilter = 'removedAt' in event;
    const reason = isFilter ? 'Filtered by AutoModerator' : 'User report';
    await queueNeedsUpdate(event.post.id, {
        reason: `${reason}: ${event.reason}`,
        removed: isFilter ? true : undefined,
    }, context);
}

export default Devvit;
