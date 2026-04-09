import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0b0b10',
          elev: '#14141c',
          hi: '#1d1d28',
        },
        border: {
          DEFAULT: '#2a2a38',
          hi: '#3a3a50',
        },
        text: {
          DEFAULT: '#e8e8f0',
          muted: '#8a8aa0',
        },
        accent: {
          DEFAULT: '#6366f1',
          hi: '#7c7ff5',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
