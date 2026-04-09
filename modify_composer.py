import sys

with open("src/components/chat/view/subcomponents/ChatComposer.tsx", "r") as f:
    content = f.read()

# 1. Update lucide-react import
# Currently: import { Check } from 'lucide-react';
# There is also `import { useTranslation } from 'react-i18next';` below it. Let's replace 'lucide-react' line.
if "import { Check } from 'lucide-react';" in content:
    content = content.replace("import { Check } from 'lucide-react';", "import { Check, Plus } from 'lucide-react';")

# 2. Change padding left classes
old_pl = "${projectName ? 'pl-[5.5rem]' : 'pl-12'}"
new_pl = "pl-5"
content = content.replace(old_pl, new_pl)

# 3. Remove the left buttons div
left_buttons_div = """            <div className="absolute left-1 top-1/2 transform -translate-y-1/2 flex items-center">
              <button
                type="button"
                onClick={openFilePicker}
                className="p-2 hover:bg-accent/60 rounded-xl transition-colors"
                title={t('input.attachFiles')}
              >
                <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                  />
                </svg>
              </button>
              {projectName && onReferenceContext && (
                <button
                  type="button"
                  onClick={() => setShowReferencePicker(!showReferencePicker)}
                  className="p-2 hover:bg-accent/60 rounded-xl transition-colors"
                  title={t('input.attachReferences')}
                >
                  <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                  </svg>
                </button>
              )}
            </div>"""

if left_buttons_div in content:
    content = content.replace(left_buttons_div, "")
else:
    print("Could not find left buttons div")

# 4. Add the Plus attach files button to the Left side of the bottom toolbar
left_side_bottom = """                {/* Left side */}
                <div className="flex items-center gap-2.5">
                  {/* Session modes — only in empty state */}"""

new_left_side = """                {/* Left side */}
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={openFilePicker}
                    className="p-1 hover:bg-accent/60 rounded-full transition-colors flex items-center justify-center text-muted-foreground"
                    title={t('input.attachFiles')}
                  >
                    <Plus className="w-4 h-4" />
                  </button>

                  {/* Session modes — only in empty state */}"""

if left_side_bottom in content:
    content = content.replace(left_side_bottom, new_left_side)
else:
    print("Could not find left side bottom toolbar")

with open("src/components/chat/view/subcomponents/ChatComposer.tsx", "w") as f:
    f.write(content)

print("Done replacing.")
