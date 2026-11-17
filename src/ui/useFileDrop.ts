import { useCallback, useRef, useState } from "react";

// Dropping files onto the app.
//
// One hook for every drop zone, so they all behave the same: the same file filter, the
// same highlight, and the same refusal to let a stray drop navigate the window away.

export interface DroppedFile {
  name: string;
  /** The file's contents as a data URL — what every store action here expects. */
  dataUrl: string;
  /** The real path on disk, which only a project file needs (it is opened by path).
   *  Comes from webUtils in the preload — see pathForFile there for why not `file.path`. */
  path?: string;
}

const IMAGE_RE = /^image\//;
const PROJECT_RE = /\.mbrush$/i;
/** A list of prompts. Accepted wherever a project file is. */
const TEXT_RE = /\.(txt|docx)$/i;

function wanted(file: File, accept: "image" | "image+project"): boolean {
  if (IMAGE_RE.test(file.type)) return true;
  return accept === "image+project" && (PROJECT_RE.test(file.name) || TEXT_RE.test(file.name));
}

/** Read the files a drop carried, in the order they were dropped. */
async function readFiles(list: FileList, accept: "image" | "image+project"): Promise<DroppedFile[]> {
  const files = Array.from(list).filter((f) => wanted(f, accept));
  return Promise.all(
    files.map(
      (f) =>
        new Promise<DroppedFile>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () =>
            resolve({
              name: f.name,
              dataUrl: String(r.result),
              path: window.mbrush?.pathForFile?.(f) || (f as File & { path?: string }).path,
            });
          r.onerror = () => reject(new Error(`קריאת ${f.name} נכשלה`));
          r.readAsDataURL(f);
        }),
    ),
  );
}

export interface FileDropOptions {
  accept?: "image" | "image+project";
  onFiles: (files: DroppedFile[]) => void;
  /** Skip the whole thing (a zone that is disabled right now). */
  disabled?: boolean;
}

/** Drop-target handlers plus the flag a zone uses to show it is armed. */
export function useFileDrop({ accept = "image", onFiles, disabled }: FileDropOptions) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a plain
  // boolean flickers as soon as the zone has any content in it. Counting the pairs is
  // what keeps the highlight steady.
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);

  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      // Without this the browser refuses the drop and the window guard swallows it.
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (disabled) return;
      e.stopPropagation();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      const list = e.dataTransfer.files;
      if (!list?.length) return;
      void readFiles(list, accept).then((files) => {
        if (files.length) onFiles(files);
      });
    },
  };

  return { dragging, handlers };
}
