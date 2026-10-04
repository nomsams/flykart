/** Keep the original live canvases beside the entire lab, including the lower tools. */
export function setupMonitorLayout(shell: HTMLElement): void {
  const workspace = shell.querySelector<HTMLElement>('.workspace')!;
  const sensors = workspace.querySelector<HTMLElement>('.sensors')!;
  const layout = document.createElement('div'); layout.className = 'habitat-layout';
  const content = document.createElement('div'); content.className = 'habitat-content';
  sensors.classList.add('sensor-rail');
  sensors.setAttribute('role', 'complementary');
  sensors.setAttribute('aria-label', 'Live camera, fly vision and room memory');
  workspace.before(layout);
  // The run and program bars stay above the grid; all remaining tools share its left column.
  while (layout.nextElementSibling) content.append(layout.nextElementSibling);
  layout.append(content);
  const mobile = window.matchMedia('(max-width: 720px)');
  const place = () => {
    if (mobile.matches) workspace.querySelector('.sidebar')!.before(sensors);
    else layout.append(sensors);
  };
  place(); mobile.addEventListener('change', place);
  // Budget from the actual top bars, including wrapping on smaller laptop windows.
  const fit = () => {
    const top = layout.getBoundingClientRect().top + window.scrollY;
    layout.style.setProperty('--monitor-height', `${Math.max(360, Math.min(680, window.innerHeight - top - 16))}px`);
  };
  const observer = new ResizeObserver(fit);
  observer.observe(shell.querySelector('.toolbar')!);
  observer.observe(shell.querySelector('.experiment')!);
  observer.observe(document.querySelector('header')!);
  window.addEventListener('resize', fit); fit();
}
