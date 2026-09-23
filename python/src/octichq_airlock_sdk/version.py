"""Who produced a span, and which build of us did it.

Both values end up on the wire — as the ``octic.sdk.*`` pair on the resource,
and as the OpenTelemetry instrumentation scope our own annotation spans are
created under. They are the same pair on purpose: a span's scope and its
resource then cannot disagree about who wrote it.
"""

from __future__ import annotations

from typing import Final

from .attributes_gen import OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK

# Stamped by release-please in the same commit as the `pyproject.toml` bump,
# once `python` is registered as a component. Reading the installed metadata at
# runtime is the obvious alternative and it is wrong here: `importlib.metadata`
# raises for a package that is on `sys.path` without having been installed,
# which is how the test suite and every editable checkout run it.
#
# The Node SDK shipped `0.0.0` for a while because `init.ts` shadowed this
# module with local constants, so every span it produced claimed a version that
# could not identify a release. There is exactly one definition of each here.
#
# The trailing marker comment is load-bearing. Do not remove it.
SDK_VERSION: Final = "0.2.0"  # x-release-please-version

# From the contract rather than a literal, because this name is not ours alone:
# the Node SDK uses the sibling member for the same two purposes, and
# `redacting_exporter` decides a span is foreign by comparing its scope against
# the whole set. Copies of one name across two languages is how that comparison
# starts failing open.
SDK_NAME: Final = OCTIC_SDK_NAME_VALUE_OCTICHQ_AIRLOCK_SDK
