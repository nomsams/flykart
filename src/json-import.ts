import './json-import.css';

type ImportOptions = { title: string; trigger?: HTMLElement; busy?: () => boolean; onError?: (message: string) => void; maxBytes?: number };

/** FileReader covers browsers/providers where File.text is missing or fails. */
export async function readTextFile(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    try { return await file.text(); } catch { /* Try the older reader before reporting failure. */ }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read this file. Open it in a text editor and paste its JSON instead.'));
    reader.onabort = () => reject(new Error('File reading was cancelled.'));
    reader.readAsText(file);
  });
}

/** Both transport paths call the same schema-validated importer. No clipboard API required. */
export function attachJsonImport(input: HTMLInputElement, receive: (text: string, name: string) => void | Promise<void>, options: ImportOptions): void {
  const dialog = document.createElement('dialog'); dialog.className = 'json-import-dialog';
  dialog.id = `${input.id}-dialog`; dialog.setAttribute('aria-labelledby', `${input.id}-title`);
  dialog.innerHTML = `<div class="json-import-heading"><h2 id="${input.id}-title"></h2><button type="button" data-close aria-label="Close import">×</button></div>
    <p>Choose a saved file, or open it in a text editor and paste the JSON below. If your phone hides JSON files, choose any file.</p>
    <div class="json-import-actions"><button type="button" data-file>Choose JSON file</button><button type="button" data-any>Choose any file</button></div>
    <form><label for="${input.id}-paste">Paste saved JSON</label><textarea id="${input.id}-paste" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Paste the complete saved JSON here…"></textarea>
    <p class="json-import-error" role="alert"></p><div class="json-import-actions"><button type="submit" class="primary">Import pasted JSON</button><button type="button" data-close>Cancel</button></div></form>`;
  dialog.querySelector('h2')!.textContent = options.title;
  document.body.append(dialog);
  const textarea = dialog.querySelector('textarea')!, error = dialog.querySelector<HTMLElement>('.json-import-error')!;
  const trigger = options.trigger ?? document.createElement('button');
  if (!options.trigger) {
    (trigger as HTMLButtonElement).type = 'button'; trigger.className = 'quiet json-import-fallback'; trigger.textContent = 'Paste / any file…';
    (input.closest('label') ?? input).after(trigger);
  }
  trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', dialog.id);
  let importing = false;
  const show = () => { if (!dialog.open) dialog.showModal(); };
  const failed = (e: unknown) => { const message = e instanceof Error ? e.message : String(e); error.textContent = message; show(); options.onError?.(message); };
  const idle = () => { if (options.busy?.()) throw new Error('Stop the active run or disconnect hardware before importing.'); };
  trigger.addEventListener('click', () => { error.textContent = ''; show(); });
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (!importing) dialog.close(); }));
  dialog.addEventListener('cancel', event => { if (importing) event.preventDefault(); });
  const choose = (any: boolean) => { try { idle(); input.accept = any ? '*/*' : '.json,application/json,text/plain'; input.click(); } catch (e) { failed(e); } };
  dialog.querySelector('[data-file]')!.addEventListener('click', () => choose(false));
  dialog.querySelector('[data-any]')!.addEventListener('click', () => choose(true));
  const apply = async (read: () => Promise<string>, name: string) => {
    if (importing) return;
    importing = true; error.textContent = '';
    dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = true);
    try {
      idle(); const text = (await read()).replace(/^\uFEFF/, '').trim();
      if (!text) throw new Error('Choose a file or paste its JSON first.');
      if (new Blob([text]).size > (options.maxBytes ?? 64_000_000)) throw new Error('JSON exceeds the import size limit.');
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error('Invalid JSON. Paste the complete file, including its opening and closing braces.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a saved JSON object.');
      idle(); await receive(text, name);
      textarea.value = ''; if (dialog.open) dialog.close();
    } catch (e) { failed(e); }
    finally { importing = false; input.value = ''; dialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = false); }
  };
  input.addEventListener('change', () => {
    const file = input.files?.[0]; if (!file) return;
    void apply(async () => { if (file.size > (options.maxBytes ?? 64_000_000)) throw new Error('File exceeds the import size limit.'); return readTextFile(file); }, file.name);
  });
  dialog.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void apply(async () => textarea.value, 'pasted-checkpoint.json'); });
}
