import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { RatWheelLoader } from '../components/RatWheelLoader';

export function AddRepoPage(props: { onDone: (repoId: number) => void }) {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const submitClone = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.cloneRepo(url);
      setMessage(`Clone queued (specimen #${res.repositoryId}). Watch progress under Repositories.`);
      setUrl('');
      props.onDone(res.repositoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitUpload = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const res = await api.uploadRepo(file);
      setMessage(`Upload queued (specimen #${res.repositoryId}). Watch progress under Repositories.`);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      props.onDone(res.repositoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>New Specimen</h1>

      {busy && <RatWheelLoader />}

      <section className="panel">
        <h2>Clone from URL</h2>
        <p className="muted text-small">Full history clone into local storage.</p>
        <div className="row">
          <input
            type="text"
            className="url-input"
            aria-label="Repository URL"
            placeholder="https://github.com/mrdoob/three.js.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="primary" disabled={busy || !url.trim()} onClick={submitClone}>
            Clone &amp; Analyse
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Upload Zip</h2>
        <p className="muted text-small">The zip must contain the repository including its .git directory.</p>
        <div className="row">
          <input
            type="file"
            accept=".zip,application/zip"
            ref={fileInput}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-label="Repository ZIP file"
          />
          <button className="primary" disabled={busy || !file} onClick={submitUpload}>
            Upload &amp; Analyse
          </button>
        </div>
      </section>

      {message && (
        <section className="panel">
          <p className="success-text">{message}</p>
        </section>
      )}
      {error && (
        <section className="panel">
          <p className="error-text">{error}</p>
        </section>
      )}
    </>
  );
}
