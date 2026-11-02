import type { Pref } from "../api";

export interface QuizShow {
  id: number;
  title: string;
  cover: string | null;
  year: number | null;
  genres: string[];
  archetype: string;
  answer: string | null;
}
export interface Option {
  key: string;
  label: string;
}
export interface QuizData {
  genres: Option[];
  themes: Option[];
  noGore: boolean;
  genrePrefs: Record<string, Pref>;
  shows: QuizShow[];
}
export interface Found {
  id: number;
  title: string;
  cover: string | null;
  year: number | null;
  format: string | null;
}
