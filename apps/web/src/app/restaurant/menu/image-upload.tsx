'use client';

import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { authErrorMessage } from '@/lib/auth/errors';

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/** Photo picker for a menu item: uploads straight away and reports the stored URL. */
export function ImageUpload({
  value,
  onChange,
  onBusy,
}: {
  value: string;
  onChange: (url: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const { client } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!ACCEPT.split(',').includes(file.type)) return setError('Use a JPG, PNG or WebP image.');
    if (file.size > MAX_BYTES) return setError('The image must be 2 MB or smaller.');
    setBusy(true);
    onBusy?.(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await client.request<{ url: string }>('/menu/images', {
        method: 'POST',
        body: form,
      });
      onChange(res.url);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
      onBusy?.(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">Photo (optional)</span>
      {value ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- uploaded file, any size */}
          <img src={value} alt="" className="size-20 rounded-lg border object-cover" />
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => input.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ImagePlus className="size-4" />
              )}
              Change photo
            </button>
            <button
              type="button"
              onClick={() => onChange('')}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-red-600"
            >
              <Trash2 className="size-4" /> Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files[0]);
          }}
          disabled={busy}
          className={`flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-5 text-sm transition-colors ${
            dragging ? 'border-primary bg-primary/5' : 'hover:bg-muted'
          }`}
        >
          {busy ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <ImagePlus className="size-5 text-muted-foreground" />
          )}
          <span className="font-medium">{busy ? 'Uploading…' : 'Upload a photo'}</span>
          <span className="text-xs text-muted-foreground">
            Click or drop a JPG, PNG or WebP · up to 2 MB
          </span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
