from dataclasses import dataclass
import sys

import discord
from discord.errors import HTTPException
from prawcore.exceptions import RequestException, ResponseException


@dataclass
class ErrorState:
    reddit_server_errors: int = 0
    reddit_request_errors: int = 0
    discord_server_errors: int = 0
    other_errors: int = 0

    def clear(self):
        self.reddit_server_errors = 0
        self.reddit_request_errors = 0
        self.discord_server_errors = 0
        self.other_errors = 0


def try_send_report(webhook: discord.SyncWebhook, content: str):
    try:
        webhook.send(content=content, wait=True)
    except Exception as e:
        print("Error sending report to Discord:", e, file=sys.stderr)


def handle_exception(
    exception: Exception,
    state: ErrorState,
    webhook: discord.SyncWebhook,
):
    if isinstance(exception, ResponseException):
        if exception.response.status_code in (500, 503):
            state.reddit_server_errors += 1
            if state.reddit_server_errors == 5:
                try_send_report(webhook, "Warning: frequent Reddit server errors.")
                print(exception, file=sys.stderr)
        else:
            state.other_errors += 1
            if state.other_errors == 5:
                try_send_report(webhook, "Reporting further errors stopped.")
            elif state.other_errors <= 5:
                try_send_report(
                    webhook, f"Reddit error {exception.response.status_code}."
                )
                print(exception, file=sys.stderr)
    elif isinstance(exception, RequestException):
        state.reddit_request_errors += 1
        if state.reddit_request_errors == 5:
            try_send_report(webhook, "Warning: frequent Reddit request errors.")
    elif isinstance(exception, HTTPException):
        if exception.status in (500, 503):
            state.discord_server_errors += 1
            if state.discord_server_errors == 5:
                try_send_report(webhook, "Warning: frequent Discord server errors.")
                print(exception, file=sys.stderr)
        else:
            state.other_errors += 1
            if state.other_errors == 5:
                try_send_report(webhook, "Reporting further errors stopped.")
            elif state.other_errors <= 5:
                try_send_report(webhook, f"Discord error {exception.status}.")
                print(exception, file=sys.stderr)
    else:
        state.other_errors += 1
        if state.other_errors == 5:
            try_send_report(webhook, "Reporting further errors stopped.")
        elif state.other_errors <= 5:
            try_send_report(webhook, "Unknown error.")
            print(exception, file=sys.stderr)
