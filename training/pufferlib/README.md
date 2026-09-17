# FlyKart + PufferLib 5

This integration targets the current [`pufferai/pufferlib`](https://github.com/pufferai/pufferlib) `5.0` branch. PufferLib 5 uses native C/CUDA environment headers, so FlyKart is provided as a fast native environment rather than trying to bundle Python into the GitHub Pages app.

## Colab setup

```bash
git clone --depth 1 --branch 5.0 https://github.com/pufferai/pufferlib.git
git clone https://github.com/nomsams/flykart.git
python flykart/training/pufferlib/install_env.py --pufferlib ./pufferlib
cd pufferlib
bash build.sh flykart
```

The installer copies the environment header and training profile into the PufferLib checkout. It refuses to overwrite a different existing FlyKart integration unless `--force` is supplied.

## Train and evaluate

```bash
./puffer train flykart
./puffer eval flykart --eval_episodes=20
```

Useful overrides are passed as `section.key=value` arguments:

```bash
./puffer train flykart env.track_set=3 env.frameskip=4 train.total_timesteps=20000000
./puffer eval flykart --eval_episodes=5 env.track_set=2
```

`track_set=3` samples all three FlyKart layouts between episodes (`0`, `1`, and `2` select Grand loop, Switchback, and Zigzag). The observation vector is nine normalized values matching the browser sensor contract: look-ahead heading error, local curvature, signed centerline offset, signed speed, centerline proximity, opponent proximity, opponent side, a phase signal, and a bias. The native single-agent environment leaves the opponent channels at zero; the browser evolution mode remains the place to race five independent brains together.

Actions are a small discrete control set:

| Action | Meaning |
| --- | --- |
| 0 | steer left and accelerate |
| 1 | keep heading and accelerate |
| 2 | steer right and accelerate |
| 3 | reverse |
| 4 | brake |

The C environment includes the same monotonic progress reward, direction reward, centerline bonus, standing-still/wrong-direction/reverse/off-track/collision/crash penalties, fixed finish reward, and off-track recovery used by the browser simulator. Its optional `puf_render` draws the track and car for native evaluation; Colab training should stay headless for throughput.

## Moving a trained policy back to FlyKart

PufferLib’s native policy weights are not the browser’s JSON spiking-brain checkpoint format. Use the browser’s `Save brain` / `Download brain` controls for a FlyKart `BrainSnapshot`. Treat a PufferLib policy as a separate accelerator experiment until a deliberate policy-conversion layer is added.
