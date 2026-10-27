// A drop target and file picker for one demo. The zone is the label of a visually hidden
// file input, so a click, or Enter on the focused input, opens the file dialog; a drop hands
// over the first dropped file. Which files are demos is the caller's check.

import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import styles from './DropZone.module.css';

interface Props {
  onFile: (file: File) => void;
  /** The input's `accept` list, a hint for the file dialog. */
  accept?: string;
  disabled?: boolean;
  children?: ReactNode;
}

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

export default function DropZone({
  onFile,
  accept,
  disabled = false,
  children,
}: Props) {
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child crossed; the zone is left when this is 0.
  const depth = useRef(0);

  const onDragEnter = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled || !carriesFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled || !carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = () => {
    if (depth.current === 0) return;
    depth.current -= 1;
    if (depth.current === 0) setOver(false);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (!disabled && file) onFile(file);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so choosing the same file again (after an error) fires another change.
    e.target.value = '';
    if (file) onFile(file);
  };

  return (
    <label
      className={styles.zone}
      data-over={over}
      data-disabled={disabled}
      data-testid="drop-zone"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        className={styles.input}
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={onChange}
        data-testid="file-input"
      />
      {children}
    </label>
  );
}
