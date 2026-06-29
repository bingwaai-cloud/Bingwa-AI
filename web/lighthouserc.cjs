module.exports = {
  ci: {
    collect: {
      startServerCommand: "npm run preview -- --port 4173",
      url: ["http://localhost:4173/"],
      numberOfRuns: 1,
      settings: {
        preset: "desktop",
        throttlingMethod: "simulate",
        throttling: {
          rttMs: 300,
          throughputKbps: 1600,
          requestLatencyMs: 300,
          downloadThroughputKbps: 1600,
          uploadThroughputKbps: 750,
          cpuSlowdownMultiplier: 4
        },
        screenEmulation: {
          mobile: true,
          width: 360,
          height: 800,
          deviceScaleFactor: 2,
          disabled: false
        }
      }
    },
    assert: {
      assertions: {
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "total-byte-weight": ["error", { maxNumericValue: 220000 }],
        "categories:accessibility": ["error", { minScore: 0.95 }]
      }
    },
    upload: {
      target: "temporary-public-storage"
    }
  }
};
