import {Comment, Devvit, Post, TriggerContext} from '@devvit/public-api';

const WEBHOOK_URL_OPTION = 'webhookUrl';
const REDIS_HASH_KEY = 'modQueue';

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
 * Handles errors received from the Discord API.
 * @param message Message to emit when a Discord request error occurs
 * @param response Response from the Discord API
 * @returns false if ratelimited, true otherwise
 */
async function handleDiscordError(message: string, response: Response): Promise<boolean> {
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
 * Gets a list of reasons why a an item is in the mod queue.
 * @param item Current mod queue item
 * @returns List of reasons why the item is in queue
 */
function getReasons(item: Post | Comment): string[] {
    // NOTE: Reddit, through the Devvit API, does not provide which moderators
    // reported the item, unlike the old Data API which does.
    const reasons = [...item.modReportReasons, ...item.userReportReasons];
    if (item instanceof Post) {
        switch (item.removedByCategory) {
            case 'anti_evil_ops':
                reasons.push('Removed by Anti-Evil Ops');
                break;
            case 'automod_filtered':
                // NOTE: Reddit does not let you know the filter reason.
                // NOTE: Reddit also does not let you know comments have been
                // filtered by AutoModerator at all, so we can only supply the
                // reason for posts.
                reasons.push('Filtered by AutoModerator');
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
async function getDiscordEmbed(item: Post | Comment): Promise<any> {
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
        // NOTE: item.removed is always false even though the item has been
        // removed by automod or otherwise.
        color: item.removed ? 0xFF0000 : 0xFFA500,
        fields: Object.entries({
            'Reasons': getReasons(item)
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
    webhookUrl: string,
    sentMessages: Record<string, string>
): Promise<boolean> {
    console.log(item.toJSON());
    const response = await fetch(`${webhookUrl}?wait=true`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            embeds: [await getDiscordEmbed(item)],
        }),
    });
    if (!response.ok) {
        return handleDiscordError('Failed to send webhook message!', response);
    }
    const responseData = await response.json();
    const messageId = responseData.id as string;
    sentMessages[item.id] = messageId;
    console.debug(`Sent message ${messageId} for item ${item.id}.`);
    return true;
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
    const response = await fetch(`${webhookUrl}/messages/${messageId}`, {
        method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
        return handleDiscordError('Failed to delete webhook message!', response);
    }
    console.debug(`Deleted message ${messageId} for resolved item ${id}.`);
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
    const sentMessages: Record<string, string> = {};
    for (const item of modQueue.filter(item => !alreadySentIdsSet.has(item.id))) {
        if (!await sendItem(item, webhookUrl, sentMessages)) {
            // Discord ratelimited us.
            break;
        }
    }
    const resolvedIds = alreadySentIds.filter(id => !currentIdsSet.has(id));
    for (const id of resolvedIds) {
        if (!await removeItem(id, webhookUrl, context)) {
            // Discord ratelimited us.
            break;
        }
    }
    if (Object.keys(sentMessages).length > 0) {
        await context.redis.hSet(REDIS_HASH_KEY, sentMessages);
    }
    if (resolvedIds.length > 0) {
        await context.redis.hDel(REDIS_HASH_KEY, resolvedIds);
    }
}

export default Devvit;
