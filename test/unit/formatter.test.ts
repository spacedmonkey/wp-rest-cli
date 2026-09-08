import { describe, expect, it } from 'vitest';
import { formatOutput } from '../../src/core/formatter.js';

const posts = [
  { id: 1, title: { rendered: 'Hello' }, link: 'https://example.com/1' },
  { id: 2, title: { rendered: 'World' }, link: 'https://example.com/2' },
];

describe('formatOutput', () => {
  it('renders json, preserving nested objects', async () => {
    const out = await formatOutput(posts[0], { format: 'json', color: false });
    expect(JSON.parse(out)).toEqual(posts[0]);
  });

  it('applies --fields to json output, keeping nested shape', async () => {
    const out = await formatOutput(posts, { format: 'json', fields: 'id,link', color: false });
    expect(JSON.parse(out)).toEqual([
      { id: 1, link: 'https://example.com/1' },
      { id: 2, link: 'https://example.com/2' },
    ]);
  });

  it('renders yaml', async () => {
    const out = await formatOutput({ id: 1, name: 'test' }, { format: 'yaml', color: false });
    expect(out).toContain('id: 1');
    expect(out).toContain('name: test');
  });

  it('renders csv with flattened nested fields', async () => {
    const out = await formatOutput(posts, {
      format: 'csv',
      fields: 'id,title.rendered',
      color: false,
    });
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('id,title.rendered');
    expect(lines[1]).toBe('1,Hello');
  });

  it('renders a table with headers and rows', async () => {
    const out = await formatOutput(posts, { format: 'table', fields: 'id,link', color: false });
    expect(out).toContain('id');
    expect(out).toContain('link');
    expect(out).toContain('https://example.com/1');
  });

  it('renders ids as a space-joined list', async () => {
    const out = await formatOutput(posts, { format: 'ids', color: false });
    expect(out).toBe('1 2');
  });

  it('renders count as the row count', async () => {
    const out = await formatOutput(posts, { format: 'count', color: false });
    expect(out).toBe('2');
  });

  it('resolves --field for a single object, returning the raw nested value', async () => {
    const out = await formatOutput(posts[0], { format: 'table', field: 'title', color: false });
    expect(JSON.parse(out)).toEqual({ rendered: 'Hello' });
  });

  it('resolves --field with a dotted path', async () => {
    const out = await formatOutput(posts[0], {
      format: 'table',
      field: 'title.rendered',
      color: false,
    });
    expect(out).toBe('Hello');
  });

  it('resolves --field across an array of rows', async () => {
    const out = await formatOutput(posts, { format: 'table', field: 'id', color: false });
    expect(JSON.parse(out)).toEqual([1, 2]);
  });

  it('shows a friendly message for an empty table', async () => {
    const out = await formatOutput([], { format: 'table', color: false });
    expect(out).toBe('No results.');
  });

  it('strips control characters from table cells instead of throwing', async () => {
    const rows = [
      {
        id: 1,
        title: { rendered: 'Tab\there' },
        content: { rendered: '<p>Line1</p>\r\n<p>Line2</p>' },
      },
    ];
    const out = await formatOutput(rows, { format: 'table', color: false });
    expect(out).toContain('Tabhere');
    expect(out).toContain('Line1');
    expect(out).toContain('Line2');
  });
});
