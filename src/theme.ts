export interface ThemeValues {
  primaryColor: string;
  primaryHover: string;
  primaryLight: string;
  primaryLightBorder: string;
  primaryDark: string;
  primaryDarkText: string;
  accentLight: string;
  accentBase: string;
  primaryMidLight: string;
  primaryDarkMid: string;
}

export interface ThemeProfile {
  id: string;
  name: string;
  description: string;
  colorPreview: string; // Tailwind class color for UI circles
  variables: ThemeValues;
}

export const THEME_PROFILES: ThemeProfile[] = [
  {
    id: 'classic-executive',
    name: 'Classic Executive',
    description: 'Professional workshop ERP branding with deep Indigo accents and high-contrast Slate panels.',
    colorPreview: 'bg-indigo-600',
    variables: {
      primaryColor: '#4f46e5',
      primaryHover: '#4338ca',
      primaryLight: '#f5f3ff',
      primaryLightBorder: '#ddd6fe',
      primaryDark: '#1e1b4b',
      primaryDarkText: '#312e81',
      accentLight: '#818cf8',
      accentBase: '#6366f1',
      primaryMidLight: '#e0e7ff',
      primaryDarkMid: '#3730a3'
    }
  },
  {
    id: 'traditional-woodcraft',
    name: 'Traditional Woodcraft',
    description: 'Saudi Woodcraft heritage theme featuring rich Emerald Green and soft organic Mint accents.',
    colorPreview: 'bg-emerald-600',
    variables: {
      primaryColor: '#059669',
      primaryHover: '#047857',
      primaryLight: '#f0fdf4',
      primaryLightBorder: '#a7f3d0',
      primaryDark: '#022c22',
      primaryDarkText: '#064e3b',
      accentLight: '#34d399',
      accentBase: '#10b981',
      primaryMidLight: '#d1fae5',
      primaryDarkMid: '#065f46'
    }
  },
  {
    id: 'amber-mahogany',
    name: 'Amber Mahogany',
    description: 'Warm, natural timber carpentry aesthetic with Cedar Amber and Bronze hardware tones.',
    colorPreview: 'bg-amber-600',
    variables: {
      primaryColor: '#d97706',
      primaryHover: '#b45309',
      primaryLight: '#fffbeb',
      primaryLightBorder: '#fde68a',
      primaryDark: '#451a03',
      primaryDarkText: '#78350f',
      accentLight: '#fbbf24',
      accentBase: '#f59e0b',
      primaryMidLight: '#fef3c7',
      primaryDarkMid: '#92400e'
    }
  },
  {
    id: 'steel-tech',
    name: 'CNC Steel Tech',
    description: 'Industrial high-tech layout with precise Cyan lasers and heavy steel metallic grey borders.',
    colorPreview: 'bg-cyan-600',
    variables: {
      primaryColor: '#0891b2',
      primaryHover: '#0e7490',
      primaryLight: '#ecfeff',
      primaryLightBorder: '#a5f3fc',
      primaryDark: '#083344',
      primaryDarkText: '#164e63',
      accentLight: '#22d3ee',
      accentBase: '#06b6d4',
      primaryMidLight: '#cffafe',
      primaryDarkMid: '#155e75'
    }
  },
  {
    id: 'cosmic-obsidian',
    name: 'Midnight Purple',
    description: 'Sleek premium evening dark aesthetic using striking Orchid and neon Violet hues.',
    colorPreview: 'bg-violet-600',
    variables: {
      primaryColor: '#7c3aed',
      primaryHover: '#6d28d9',
      primaryLight: '#f5f3ff',
      primaryLightBorder: '#ddd6fe',
      primaryDark: '#2e1065',
      primaryDarkText: '#4c1d95',
      accentLight: '#a78bfa',
      accentBase: '#8b5cf6',
      primaryMidLight: '#ede9fe',
      primaryDarkMid: '#5b21b6'
    }
  }
];

export function applyTheme(themeId: string) {
  const theme = THEME_PROFILES.find(t => t.id === themeId) || THEME_PROFILES[0];
  const root = document.documentElement;
  
  root.style.setProperty('--primary-color', theme.variables.primaryColor);
  root.style.setProperty('--primary-hover', theme.variables.primaryHover);
  root.style.setProperty('--primary-light', theme.variables.primaryLight);
  root.style.setProperty('--primary-light-border', theme.variables.primaryLightBorder);
  root.style.setProperty('--primary-dark', theme.variables.primaryDark);
  root.style.setProperty('--primary-dark-text', theme.variables.primaryDarkText);
  root.style.setProperty('--accent-light', theme.variables.accentLight);
  root.style.setProperty('--accent-base', theme.variables.accentBase);
  root.style.setProperty('--primary-mid-light', theme.variables.primaryMidLight);
  root.style.setProperty('--primary-dark-mid', theme.variables.primaryDarkMid);
}
