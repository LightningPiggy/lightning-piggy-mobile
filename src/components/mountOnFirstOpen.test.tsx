import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { mountOnFirstOpen } from './mountOnFirstOpen';

const mounts = jest.fn();
const Sheet: React.FC<{ visible: boolean; label: string }> = ({ visible, label }) => {
  React.useEffect(() => {
    mounts();
  }, []);
  return <Text testID="sheet">{`${label}:${visible ? 'open' : 'closed'}`}</Text>;
};
const LazySheet = mountOnFirstOpen(Sheet, 'test', (p) => p.visible);

describe('mountOnFirstOpen', () => {
  beforeEach(() => mounts.mockClear());

  it('renders nothing until the sheet first opens', () => {
    const view = render(<LazySheet visible={false} label="a" />);
    expect(view.queryByTestId('sheet')).toBeNull();
    expect(mounts).not.toHaveBeenCalled();
  });

  it('mounts already open, then stays mounted (once) across closes', () => {
    const view = render(<LazySheet visible={false} label="a" />);
    view.rerender(<LazySheet visible label="a" />);
    expect(view.getByTestId('sheet').props.children).toBe('a:open');
    view.rerender(<LazySheet visible={false} label="b" />);
    expect(view.getByTestId('sheet').props.children).toBe('b:closed');
    view.rerender(<LazySheet visible label="b" />);
    expect(mounts).toHaveBeenCalledTimes(1);
  });
});
