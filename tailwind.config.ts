import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Lifted verbatim from the on-device dashboard's own HTML/CSS
        // (src/main.cpp's handleDashboard()), per docs/style-guide.md — the
        // whole webapp adopts this rather than a generic dark-slate theme,
        // since it's a direct extension of the physical device's screen.
        device: {
          screen: '#122333', // page/section background
          card: '#1D3A57', // card background
          surface: '#141414', // nav tiles, status box, event rows
          'surface-hover': '#1f1f1f',
          text: '#eee', // primary text
          'text-secondary': '#B8C4D0',
          'text-tertiary': '#93A8BD',
          accent: '#4FD1C5', // links, checked switch track, temp chart line
          good: '#48BB78', // normal/healthy/on
          alert: '#F56565', // too hot/humid, critical
          heating: '#F6AD55', // warm/warning
          cool: '#4299E1', // misting, humidity chart line
          dry: '#C05621', // low-humidity gauge zone
          disabled: '#888', // automation disabled / neutral
          'active-border': '#6EC9E6', // outlet-on badge border
        },
      },
      boxShadow: {
        device: '0 0 10px rgba(0,0,0,0.5)',
      },
    },
  },
  plugins: [],
} satisfies Config;
