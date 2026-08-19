/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#121212', // Spotify dark
        surface: '#181818',
        surfaceElevated: '#282828',
        accent: '#1DB954', // Spotify green
        accentHover: '#1ed760',
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
