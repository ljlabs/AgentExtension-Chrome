export default function StatusBar({ text }) {
  if (!text) return null;

  return (
    <div id="statusBar" className="status">
      {text}
    </div>
  );
}
