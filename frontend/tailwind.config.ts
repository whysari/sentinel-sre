import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        sentinel: {
          void: "#05070d",
          panel: "#0b1120",
          elevated: "#111a2e",
          border: "#1e2a44",
          muted: "#8593ad",
          ink: "#e7edf8",
          accent: "#38bdf8",
          violet: "#a78bfa",
          amber: "#fbbf24",
          crimson: "#f43f5e",
          emerald: "#34d399",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(56, 189, 248, 0.18), 0 18px 50px -24px rgba(56, 189, 248, 0.55)",
        danger: "0 0 0 1px rgba(244, 63, 94, 0.25), 0 18px 45px -24px rgba(244, 63, 94, 0.6)",
      },
      keyframes: {
        "pulse-ring": {
          "0%, 100%": { opacity: "0.35", transform: "scale(1)" },
          "50%": { opacity: "0.9", transform: "scale(1.06)" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 2.2s ease-in-out infinite",
        "slide-up": "slide-up 260ms ease-out both",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
