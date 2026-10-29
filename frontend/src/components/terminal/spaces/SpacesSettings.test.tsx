import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SpacesSettings } from './SpacesSettings';

vi.mock('../settings/metaAgent/MetaAgentSettings', () => ({ MetaAgentSettings: () => <p>Meta agent form</p> }));
vi.mock('./components/ComponentsSettings', () => {
  const pending = new Promise(() => {});
  return { ComponentsSettings: () => { throw pending; } };
});

it('keeps Pages settings navigation available while the component library is loading', async () => {
  const onBack = vi.fn();
  render(<SpacesSettings onBack={onBack} />);
  expect(await screen.findByText('Meta agent form')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Browse components' }));
  expect(screen.getByRole('status').textContent).toBe('Loading components…');
  fireEvent.click(screen.getByRole('button', { name: /Back to settings/ }));
  expect(await screen.findByText('Meta agent form')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Back to Pages/ }));
  expect(onBack).toHaveBeenCalledOnce();
});
