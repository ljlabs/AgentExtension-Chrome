const PLURALS = { memories: "memory", skills: "skill", rules: "rule" };
const VOWEL_ITEMS = new Set(["item"]);

export default function EmptyState({ label }) {
  const singular = label ? (PLURALS[label.toLowerCase()] || label.slice(0, -1)) : "item";
  const article = VOWEL_ITEMS.has(singular) ? "an" : "a";

  return (
    <div className="empty-state">
      <div className="empty-state-icon">📝</div>
      <div className="empty-state-text">
        Select {article} {singular} from the list to edit
      </div>
    </div>
  );
}
