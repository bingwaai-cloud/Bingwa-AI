import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en.json";
import lg from "@/locales/lg.json";
import sw from "@/locales/sw.json";

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    lg: { translation: lg },
    sw: { translation: sw }
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false
  }
});

export default i18n;
