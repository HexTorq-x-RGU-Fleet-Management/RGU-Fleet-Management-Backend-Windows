# Frozen local camera-engine source

Copied from the existing Windows v2 implementation on 25 October 2026 for source
independence only. lib/, native/ and tools/test-frames.py are local copies; v3
imports these files directly. No feature or protocol changes were made.
This folder includes Python source and requirements, not vendor DLLs or account
credentials. Runtime still uses the installed authorized SDK. Changes to v2 no
longer propagate here. Optional browser probe files retain the original local
Chrome workflow and must not be invoked to expose credential-bearing stdout.
