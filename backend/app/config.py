import os
from pathlib import Path


CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "./config"))
BOOKS_DIR = Path(os.environ.get("BOOKS_DIR", "/books"))
DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", "/downloads"))
IRC_STATE_DIR = Path(os.environ.get("IRC_STATE_DIR", str(CONFIG_DIR / "irc")))
DATABASE_URL = f"sqlite+aiosqlite:///{CONFIG_DIR}/booksarr.db"
PORT = int(os.environ.get("PORT", "8889"))
HARDCOVER_API_KEY = os.environ.get("HARDCOVER_API_KEY", "")
GOOGLE_BOOKS_API_KEY = os.environ.get("GOOGLE_BOOKS_API_KEY", "")

# Audiobookshelf integration
ABS_URL = os.environ.get("ABS_URL", "")
ABS_API_KEY = os.environ.get("ABS_API_KEY", "")
ABS_LIBRARY_ID = os.environ.get("ABS_LIBRARY_ID", "")

CONFIG_DIR.mkdir(parents=True, exist_ok=True)
(CONFIG_DIR / "cache" / "authors").mkdir(parents=True, exist_ok=True)
(CONFIG_DIR / "cache" / "books").mkdir(parents=True, exist_ok=True)
try:
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
except PermissionError:
    # Container startup may occur before the downloads volume exists.
    # Later phases will surface this through IRC status and logs.
    pass
IRC_STATE_DIR.mkdir(parents=True, exist_ok=True)
