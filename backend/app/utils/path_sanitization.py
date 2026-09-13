"""
Filesystem path sanitization utilities.

Provides functions to sanitize strings for use in filesystem paths,
particularly for Windows/SMB compatibility where certain characters
are illegal and cause 8.3 fallback naming.
"""

import re


def sanitize_for_filesystem(value: str, fallback: str = "Unknown") -> str:
    """Sanitize a string for use in filesystem paths (Windows/SMB compatible).

    Removes/replaces characters illegal in Windows filenames to prevent
    8.3 fallback on SMB mounts. Also strips trailing spaces/dots which
    Windows doesn't allow.

    Args:
        value: The string to sanitize (e.g., author name, book title).
        fallback: Value to return if sanitization results in empty string.

    Returns:
        Sanitized string safe for use in filesystem paths.
    """
    # Replace illegal chars with space: < > : " / \ | ? * and control chars
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", value)
    # Collapse multiple spaces to single
    sanitized = re.sub(r"\s+", " ", sanitized)
    # Strip leading/trailing whitespace and trailing dots (Windows restriction)
    sanitized = sanitized.strip().rstrip(".")
    return sanitized or fallback
