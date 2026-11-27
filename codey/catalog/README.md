# Codey model limit snapshot

The snapshot contains only the public numeric limits of canonical Models.dev chat models with text input and output. It indexes their exact, case-sensitive `lab/model` paths from the Models.dev `models/` tree. Gateway-specific aliases are outside this index. See [Models.dev's repository and schema](https://github.com/anomalyco/models.dev/tree/d66aa6c9c4b4f75033fd55c9b0b0fcf9ccd2a472).

Regenerate with Python 3.11 or later from the repository root. The snapshot records the full source revision. Generating twice from the same revision produces identical bytes.

```sh
git clone --no-checkout https://github.com/anomalyco/models.dev.git /tmp/codey-models-dev-source
python3 codey/catalog/generate-limits.py /tmp/codey-models-dev-source d66aa6c9c4b4f75033fd55c9b0b0fcf9ccd2a472 > codey/catalog/model-limits.json
```

When updating the snapshot, select an exact Models.dev commit, update the command above, and review the generated changes. Codey loads the shipped snapshot locally. Models.dev data is distributed under the accompanying [MIT license](Models.dev.LICENSE).
