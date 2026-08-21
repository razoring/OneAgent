/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#171717',
        surface: '#212121',
        surfaceElevated: '#2a2a2a',
        overlay: '#1e1e1e',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        accentHover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        accentBright: 'rgb(var(--accent-bright-rgb) / <alpha-value>)',
        textPrimary: '#ffffff',
        textSecondary: '#b3b3b3',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
