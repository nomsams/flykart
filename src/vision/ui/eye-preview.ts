import { cropView, DEFAULT_VISION, VisualFilter, viewPatches, VisionSettings } from '../../robot/vision-workbench';
import { lowResolution, VisionEnsemble } from '../ensemble';
import type { CameraConfig } from '../camera';
import type { RacingSettings } from '../racing-settings';
import { drawEye } from './draw';

/** Display inputs without running the eyes or advancing their temporal history. */
export class EyePreview {
  readonly gallery: HTMLDivElement;
  private readonly status: HTMLParagraphElement;
  private cards: { canvas: HTMLCanvasElement; label: HTMLElement }[] = [];

  constructor(domain: 'track' | 'world') {
    const section = document.createElement('details');
    section.className = 'eye-preview'; section.open = true;
    const title = document.createElement('summary'); title.textContent = 'Virtual eye inputs · crops & zoom';
    this.status = document.createElement('p'); this.status.className = 'note';
    this.status.id = domain === 'track' ? 'eye-disagreement' : 'world-eye-disagreement';
    this.gallery = document.createElement('div'); this.gallery.className = 'eye-preview-grid';
    this.gallery.id = domain === 'track' ? 'virtual-eyes' : 'world-virtual-eyes';
    section.append(title, this.status, this.gallery);
    const host=domain==='world'?document.getElementById('world-eye-settings')!:document.getElementById(domain + '-eye')!.closest('.view-box')!;
    host.append(section);
  }

  paint(raw: Float32Array, camera: CameraConfig, settings: { visual?: VisionSettings; resolution?: RacingSettings['resolution'] }, ensemble: VisionEnsemble | null, inactive?: string): void {
    const visual = settings.visual ?? DEFAULT_VISION, patches = viewPatches(visual);
    const inferred = !inactive && ensemble?.frames.length === patches.length;
    // A paused new session has no inferred frames yet. Use an isolated filter so
    // refreshing its preview cannot teach memory, call the CNN or fill its history.
    const processed = inferred ? null : new VisualFilter().process(lowResolution(raw, camera.width, camera.height, settings.resolution ?? 'native'), camera.width, camera.height, visual);
    const frames = inferred ? ensemble!.frames : patches.map((p, i) => i === 0 ? processed! : cropView(processed!, camera.width, camera.height, p));
    if (this.cards.length !== frames.length) {
      this.gallery.replaceChildren();
      this.cards = frames.map((_, i) => {
        const card = document.createElement('figure'), canvas = document.createElement('canvas'), label = document.createElement('figcaption');
        canvas.setAttribute('aria-label', `Virtual eye ${i + 1} input`);
        card.append(canvas, label); this.gallery.append(card); return { canvas, label };
      });
    }
    frames.forEach((frame, i) => {
      const { canvas, label } = this.cards[i], patch = patches[i];
      // One native pixel per tensor sample; CSS preserves the camera's aspect ratio.
      if (canvas.width !== camera.width) canvas.width = camera.width;
      if (canvas.height !== camera.height) canvas.height = camera.height;
      drawEye(canvas, frame, camera);
      label.textContent = `Eye ${i + 1} · ${i === 0 ? 'centre' : `${Math.round(patch.x * 100)}% X / ${Math.round(patch.y * 100)}% Y`} · ${Math.round(patch.scale * 100)}% field`;
    });
    this.gallery.dataset.source = inferred ? 'inference' : 'preview';
    this.gallery.dataset.views = String(frames.length);
    this.status.textContent = `${frames.length} view(s) · ${camera.width}×${camera.height} RGB per view · ` + (inferred
      ? `last inputs used by the eye networks · disagreement ${ensemble!.disagreement.toFixed(3)}`
      : `setup preview only · ${inactive ?? 'press Start for inference'}${visual.temporal > 1 ? '; temporal averaging starts when driving' : ''}`);
  }
}
