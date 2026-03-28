import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        bg: '#080810',
        surface: '#0f0f1a',
        border: '#1e1e30',
        violet: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
        },
      },
      boxShadow: {
        'violet-sm': '0 0 12px rgba(139, 92, 246, 0.35)',
        'violet-md': '0 0 24px rgba(139, 92, 246, 0.5)',
        'violet-lg': '0 0 48px rgba(139, 92, 246, 0.65)',
      },
    },
  },
  plugins: [],
};

export default config;
