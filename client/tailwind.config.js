/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        neon: '0 0 0 1px rgba(255, 0, 90, 0.20), 0 10px 40px rgba(255, 0, 90, 0.20)',
      },
    },
  },
  plugins: [],
};

