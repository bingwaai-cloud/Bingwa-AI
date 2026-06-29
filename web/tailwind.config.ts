import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))"
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))"
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        gezi: {
          green: {
            900: "var(--gezi-green-900)",
            700: "var(--gezi-green-700)",
            100: "var(--gezi-green-100)"
          },
          gold: {
            500: "var(--gezi-gold-500)"
          }
        },
        ink: {
          900: "var(--ink-900)",
          600: "var(--ink-600)",
          400: "var(--ink-400)"
        },
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)"
        },
        line: "var(--line)",
        danger: {
          600: "var(--danger-600)"
        },
        warn: {
          600: "var(--warn-600)"
        },
        info: {
          600: "var(--info-600)"
        }
      },
      borderRadius: {
        lg: "var(--radius-card)",
        md: "var(--radius-control)",
        sm: "calc(var(--radius-control) - 2px)"
      },
      fontFamily: {
        sans: ["InterVariable", "Inter", "system-ui", "sans-serif"]
      },
      boxShadow: {
        subtle: "0 1px 2px rgb(16 20 24 / 0.08), 0 8px 24px rgb(16 20 24 / 0.06)"
      },
      transitionTimingFunction: {
        gezi: "ease-out"
      },
      transitionDuration: {
        150: "150ms"
      }
    }
  },
  plugins: [animate]
};

export default config;
