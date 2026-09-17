"""Install the FlyKart environment into a PufferLib 5 checkout.

This is intentionally a small, dependency-free copier so it works in a fresh
Google Colab runtime before any Python packages are installed.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


def main() -> None:
    parser = argparse.ArgumentParser(description="Install FlyKart into PufferLib 5")
    parser.add_argument("--pufferlib", type=Path, required=True, help="path to a PufferLib checkout")
    parser.add_argument("--force", action="store_true", help="replace an existing FlyKart integration")
    args = parser.parse_args()

    source = Path(__file__).resolve().parent
    destination = args.pufferlib.resolve()
    if not (destination / "build.sh").is_file() or not (destination / "src" / "pufferl.cu").is_file():
        raise SystemExit(f"{destination} does not look like a PufferLib 5 checkout")

    env_destination = destination / "ocean" / "flykart" / "flykart.h"
    config_destination = destination / "config" / "flykart.ini"
    for target in (env_destination, config_destination):
        if target.exists() and not args.force:
            raise SystemExit(f"{target} already exists; use --force only if replacing it is intentional")

    env_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "flykart.h", env_destination)
    shutil.copy2(source / "flykart.ini", config_destination)
    print(f"Installed {env_destination}")
    print(f"Installed {config_destination}")
    print("Next: cd into PufferLib and run `bash build.sh flykart`.")


if __name__ == "__main__":
    main()
