import { createClient } from 'microcms-js-sdk';

const serviceDomain = import.meta.env.MICROCMS_SERVICE_DOMAIN || 'placeholder';
const apiKey = import.meta.env.MICROCMS_API_KEY || 'placeholder';

export const client = createClient({ serviceDomain, apiKey });

export type NewsItem = {
  id: string;
  title: string;
  category: string;
  content: string;
  publishedAt: string;
  createdAt: string;
};

export type BlogItem = {
  id: string;
  title: string;
  category: string;
  thumbnail?: { url: string; width: number; height: number };
  content: string;
  author: string;
  publishedAt: string;
  createdAt: string;
};
