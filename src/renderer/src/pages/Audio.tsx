import { useState } from 'react'
import { RuleEditor } from './audio/RuleEditor'
import { RulesLibrary } from './audio/RulesLibrary'

/** The Audio rules tab: the library of rules first; a rule opens in the editor. */
export default function AudioPage() {
  const [editing, setEditing] = useState<string | null>(null)
  return editing === null ? <RulesLibrary onOpen={setEditing} /> : <RuleEditor key={editing} initialKey={editing} onBack={() => setEditing(null)} />
}
