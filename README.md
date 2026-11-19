# Logical clock visualizer

A local, interactive distributed systems lab built with Python, uv, plain JavaScript and SVG. No runtime dependencies, JavaScript build tools, or external assets.

## AI Use

The project was coded using Codex with GPT-6.1 Sol and GPT-6.2 Sol.

## Run

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then from this directory:

```bash
uv run clock-server
```

Open **http://localhost:8888**.

### GitHub Codespaces

On GitHub, select **Code > Codespaces > Create codespace**. When setup finishes, run this in the Codespaces terminal:

```bash
uv run clock-server --host 0.0.0.0
```

In the **Ports** tab, select **Open in Browser** for port **8888**.
