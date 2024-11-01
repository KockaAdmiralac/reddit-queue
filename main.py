import configparser
import sys
import time
from typing import List

import discord
import praw
from praw.models import Comment, Submission, Subreddit
from praw.models.listing.mixins import subreddit

from db import DB
from errors import ErrorState, handle_exception
from util import get_config_dir


def get_config() -> configparser.ConfigParser:
    config_path = get_config_dir() / "config.ini"
    config = configparser.ConfigParser()
    config.read(config_path)
    return config


def auth_to_reddit(config: configparser.ConfigParser, db: DB) -> Subreddit:
    refresh_token = db.get_refresh_token()
    reddit = praw.Reddit(
        client_id=config["Reddit"]["ClientID"],
        client_secret=config["Reddit"]["ClientSecret"],
        redirect_uri="https://kocka.tech",
        user_agent="r/UndertaleYellow mod queue relay by u/KockaAdmiralac",
        refresh_token=refresh_token,
    )
    if refresh_token is None:
        if not sys.stdin.isatty():
            raise Exception(
                "No refresh token in the database, please use interactive mode."
            )
        print(
            "Use the URL:",
            reddit.auth.url(scopes=["read"], state="123", duration="permanent"),
        )
        code = input("Give the code: ")
        refresh_token = reddit.auth.authorize(code)
        if refresh_token is not None:
            db.set_refresh_token(refresh_token)
    return reddit.subreddit(config["Reddit"]["Subreddit"])


def get_webhook(config: configparser.ConfigParser) -> discord.SyncWebhook:
    return discord.SyncWebhook.from_url(config["Discord"]["Webhook"])


def create_comment_em(comment: Comment) -> discord.Embed:
    reports = comment.mod_reports + comment.user_reports
    report_string = "\n".join([f"{r[1]}: {r[0]}" for r in reports])
    return discord.Embed(
        title=f"Comment by {comment.author}"[:250],
        description=f"{comment.body}\n\n{report_string}"[:4000],
        url=f"https://reddit.com{comment.permalink}",
        color=0xEEEEEE,
    ).set_author(name=f"u/{comment.author}")


def create_post_em(submission: Submission) -> discord.Embed:
    reports = submission.mod_reports + submission.user_reports
    report_string = "\n".join([f"{r[1]}: {r[0]}" for r in reports])
    if submission.is_self:
        title_string = submission.title
    else:
        title_string = f"{submission.title} ({submission.domain})"
    em = discord.Embed(
        title=title_string[:250],
        description=report_string[:4000],
        url=f"https://redd.it/{submission.id}",
        color=0x00BCD4,
    ).set_author(name=f"u/{submission.author}")
    if not submission.is_self and hasattr(submission, "preview"):
        em.set_thumbnail(url=submission.preview["images"][0]["resolutions"][0]["url"])
    return em


def add_reports(
    subreddit: Subreddit, webhook: discord.SyncWebhook, db: DB
) -> List[int]:
    current_reports = []
    for submission in subreddit.mod.modqueue():
        current_reports.append(submission.id)
        if db.is_report_added(submission.id):
            continue
        if isinstance(submission, Comment):
            em = create_comment_em(submission)
        else:
            em = create_post_em(submission)
        msg = webhook.send(embed=em, wait=True)
        db.add_report(submission.id, str(msg.id))
    return current_reports


def delete_resolved_reports(
    current_reports: List[int], db: DB, webhook: discord.SyncWebhook
):
    unresolved_reports = db.get_unresolved_reports()
    for report in unresolved_reports:
        report_id = report[0]
        if report_id not in current_reports:
            webhook.delete_message(db.get_message_id(report_id))
            db.mark_report_resolved(report_id)


if __name__ == "__main__":
    config = get_config()
    db = DB()
    subreddit = auth_to_reddit(config, db)
    webhook = get_webhook(config)
    webhook.send("Service started.")
    state = ErrorState()
    while True:
        try:
            current_reports = add_reports(subreddit, webhook, db)
            delete_resolved_reports(current_reports, db, webhook)
            time.sleep(10)
            state.clear()
        except KeyboardInterrupt:
            break
        except Exception as e:
            handle_exception(e, state, webhook)
            time.sleep(120)
