import { describe, expect, it } from 'vitest';
import { userDatabase } from '../dbTestData';
import { titleColumn } from '../dbModel';
import { gallerySnippet } from './GalleryView';

describe('gallerySnippet', () => {
  it("reads a row's body as plain words, and only its start when the body is long", () => {
    const db = userDatabase();
    const title = titleColumn(db);
    expect(gallerySnippet(db, db.rows[0], title)).toBe('Kanra or Ace');
    const long = { ...db.rows[1], body: `**Start** here. ${'more words '.repeat(5_000)}` };
    const words = gallerySnippet(db, long, title);
    expect(words.startsWith('Start here. more words')).toBe(true);
    expect(words.length).toBeLessThanOrEqual(500);
  });
});
