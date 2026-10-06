export const PALETTES = [
  { id: 'blue-light', name: 'Blue', mode: 'Light', label: 'White and blue' },
  { id: 'blue-dark', name: 'Blue', mode: 'Dark', label: 'Black and deep blue' },
  { id: 'pink-light', name: 'Pink', mode: 'Light', label: 'White and pink' },
  { id: 'pink-dark', name: 'Pink', mode: 'Dark', label: 'Black and deep pink' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];
export interface Appearance {
  palette: PaletteId;
  pixelFont: boolean;
}

const STORAGE_KEY = 'rat.appearance';
const DEFAULT_APPEARANCE: Appearance = { palette: 'blue-light', pixelFont: false };

export function readAppearance(): Appearance {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_APPEARANCE };
    const value = saved as Record<string, unknown>;
    return {
      palette: PALETTES.find((palette) => palette.id === value.palette)?.id ?? DEFAULT_APPEARANCE.palette,
      pixelFont: typeof value.pixelFont === 'boolean' ? value.pixelFont : DEFAULT_APPEARANCE.pixelFont,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function applyAppearance(appearance: Appearance): void {
  document.documentElement.dataset.theme = appearance.palette;
  document.documentElement.dataset.font = appearance.pixelFont ? 'pixel' : 'standard';
}

export function saveAppearance(appearance: Appearance): void {
  applyAppearance(appearance);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Appearance still works for this session when browser storage is unavailable.
  }
}
