## Compute Resource Guard (Experiment Stage)

**Before running ANY experiment, training script, evaluation, or GPU-intensive computation**, you MUST first verify that adequate compute resources are available. This applies whether the user invokes a skill explicitly or asks in natural language (e.g., "run the experiment", "train the model", "evaluate on the test set").

**How to check:**
1. Run `nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv,noheader` for CUDA GPUs, or check MPS via `python3 -c "import torch; print(torch.backends.mps.is_available())"` on Mac.
2. For remote servers, check SSH connectivity and GPU via `ssh <server> nvidia-smi ...`.
3. Compare the experiment's resource requirements (GPU count, VRAM, RAM) against what is actually available.

**If compute resources are insufficient or unavailable:**
- **STOP.** Do NOT run training scripts, evaluation scripts, or any experiment code.
- **Do NOT fabricate, imagine, or hallucinate experiment results.** This is the single most important rule for the experiment stage. An experiment that was never executed has no results.
- **Report clearly** to the user: what resources the experiment needs, what is currently available, and concrete alternatives (e.g., `gpu: modal` for serverless GPU, `gpu: vast` for on-demand rental, or configuring a remote GPU server).
- **Do NOT** continue the experiment pipeline or attempt workarounds like running a GPU experiment on CPU unless the user explicitly agrees.

**If compute resources are available:** Briefly confirm (e.g., "GPU 0: RTX 4090, 22GB free — proceeding") and continue with the experiment.

The `/aris-compute-guard` skill in the skills library provides a detailed procedure for this check. Use it when available, or perform the checks inline as described above.
