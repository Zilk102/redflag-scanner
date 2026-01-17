/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'neon-red': '#FF2A6D',
        'neon-blue': '#05D9E8',
        'deep-bg': '#01012B',
        'card-bg': '#1A1A40',
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'Noto Sans',
          'sans-serif',
        ],
      },
      boxShadow: {
        neon: '0 0 0 1px rgba(255, 0, 90, 0.20), 0 10px 40px rgba(255, 0, 90, 0.20)',
      },
    },
  },
  plugins: [],
};
