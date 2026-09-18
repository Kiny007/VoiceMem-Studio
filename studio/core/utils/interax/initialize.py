"""Resolve optional Studio integration configuration without contacting Interax."""
from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlsplit

from studio.paths import ROOT


@dataclass(frozen=True)
class Settings:
    base_url: str
    root: Path
    state_path: Path = ROOT / "results" / "task-orchestration.sqlite"
    max_sessions: int = 8
    max_owners: int = 32
    max_polls: int = 4
    max_models: int = 2


def configuration():
    """Return settings when enabled; reject ambiguous or credential-bearing URLs."""
    base_url = os.environ.get("STUDIO_INTERAX_BASE_URL", "").strip()
    if not base_url:
        return None
    url = urlsplit(base_url)
    if (url.scheme not in {"http", "https"} or not url.hostname
            or url.username or url.password or url.query or url.fragment):
        raise ValueError("STUDIO_INTERAX_BASE_URL must be an HTTP(S) service or proxy URL without credentials, query or fragment")
    url.port
    root = Path(os.environ.get("STUDIO_INTERAX_ROOT") or ROOT.parent / "Interax").expanduser().resolve()
    limits = {name: int(os.environ.get("STUDIO_INTERAX_" + name.upper(), default))
              for name, default in {"max_sessions": 8, "max_owners": 32, "max_polls": 4, "max_models": 2}.items()}
    if any(not 1 <= value <= 128 for value in limits.values()):
        raise ValueError("Interax resource limits must be 1..128")
    return Settings(base_url, root, Path(os.environ.get("STUDIO_INTERAX_STATE_PATH") or
                                       ROOT / "results" / "task-orchestration.sqlite"), **limits)


def check(settings, *, mode, provider):
    """Validate the selected adapter and upstream source graph without network I/O."""
    if settings is None:
        return
    if mode != "llm_tts" or provider not in {"deepseek", "qwen", "openai"}:
        raise ValueError("Interax requires llm_tts with deepseek, qwen or openai")
    for relative in ("src/interax_sdk/index.js", "src/interax_sdk/package.json",
                     "src/interax_sdk/browser.js", "src/interax_sdk/src/viewport.js",
                     "demo/web/catalog.js", "demo/web/controller.js"):
        if not (settings.root / relative).is_file():
            raise ValueError(f"STUDIO_INTERAX_ROOT is missing {relative}")
    node = shutil.which("node")
    if not node:
        raise ValueError("Interax SDK bridge requires Node.js >=22.12 on PATH")
    try:
        version = subprocess.run([node, "--version"], capture_output=True, text=True,
                                 timeout=5, check=True).stdout.strip().lstrip("v")
        supported = tuple(int(n) for n in version.split(".")[:2]) >= (22, 12)
    except (subprocess.SubprocessError, ValueError) as exc:
        raise ValueError("Could not determine the installed Node.js version") from exc
    if not supported:
        raise ValueError("Interax Demo ESM wrappers require Node.js >=22.12")
