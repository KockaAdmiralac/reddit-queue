import os.path
from pathlib import Path


def get_script_dir() -> Path:
    return Path(os.path.dirname(os.path.realpath(__file__)))


def get_cache_dir() -> Path:
    if "REDDIT_QUEUE_CACHE_DIR" in os.environ:
        return Path(os.environ["REDDIT_QUEUE_CACHE_DIR"])
    return get_script_dir()


def get_config_dir() -> Path:
    if "REDDIT_QUEUE_CONFIG_DIR" in os.environ:
        return Path(os.environ["REDDIT_QUEUE_CONFIG_DIR"])
    return get_script_dir()
