---
name: nexus-design-taste
description: Reference for the specific ways generated UI converges on a generic template — uniform rounded card grids, one border-radius applied to everything regardless of nesting, the same soft shadow under every surface, all-caps eyebrow labels, middot slogan strings, one accented word in a headline, arrows appended to every link. Each entry names an observable trait and a concrete alternative. Load this BEFORE writing any markup, component, or stylesheet, and whenever output "looks fine but feels like a template" or "looks like every other AI-generated page".
---

# Design taste: the convergence catalogue

You are reading this because you are about to make a visual decision, or because
something you just made looks like everything else you have made. Both are worth
the detour.

## What convergence actually is

The patterns below are not bad taste and they are not a style. They are what
happens when output is generated without a decision being made: a plausible
prior gets sampled, and because the prior is the average of a very large number
of pages, the result is recognisable as the average and specific to nothing.

That framing matters, because it changes the fix. "Make it less generic" is not
an instruction you can act on. "This radius is carrying no information" is. Every
entry below is phrased as an observable trait plus the decision that trait is
standing in for. The habit to build is not taste, it is noticing which decision
is missing.

The traits are worth recognising as *traits*. A purple gradient hero section does
not look bad. It looks like the absence of a decision about what the top of this
page is for.

## The catalogue

### The uniform card grid

**Trait:** every item in a set is boxed — same padding, same radius, same
shadow, same fixed height — so the set reads as a row of interchangeable
products rather than a set of things with different jobs.

**Why it is a prior and not a choice:** cards are the container people reach for
when the *shape of the group* has not been worked out. The card asserts "these
items are equivalent and equivalent items should look the same", which is
frequently false — a pricing table's most popular plan is not equivalent to the
others, and a search result with 3 lines and one with 12 are not equivalent.

**Alternative:** let the content decide the container. Group with space and a
shared heading; separate with a rule when the set is a list of peers; reserve a
card for the one item that is genuinely a discrete unit, and let it be visibly
different from its neighbours. A row where one item is elevated because it is
the recommendation is more informative than five identical cards.

### One radius, everywhere

**Trait:** a single `--radius: 8px` (or 12px, or 16px) applied to the button,
the card, the input, the image and the badge, so the whole interface reads as
one flat material with rounded edges.

**Why:** radius was standardised, and standardising it felt like consistency.

**Alternative:** radius is a statement about *what is inside what*. Use it to
express nesting — a pill on the outermost container, a smaller radius on the
input inside it — or use zero on anything that should read as part of the page's
surface rather than an object placed on it. A design where every corner is the
same corner has not used the one property that could have been informative.

### The same soft shadow under everything

**Trait:** a low-opacity grey drop shadow on every card, button and panel,
identical in offset and blur.

**Why:** a shadow is cheap and always looks considered.

**Alternative:** a shadow is a claim of elevation, and elevation is scarce. If
everything floats, nothing is above anything. Most surfaces should be flat, held
off the page by a background step or a hairline border, and shadow should be
reserved for the things that genuinely *are* floating — a popover, a dragged
card, a sticky bar, a dialog. If you can name what is above what, the shadow is
earning its place; if you cannot, delete it.

### The gradient hero

**Trait:** a full-bleed purple-to-indigo gradient behind a centred headline, a
one-line subhead, and two buttons.

**Why:** it is the highest-frequency layout in the training distribution for
"landing page", and it is a placeholder for the question the hero exists to
answer.

**Alternative:** answer the question in the space. The top of a page should be
able to state what the product does in a sentence a stranger understands, at the
size a stranger can read. If there is a gradient, it is doing a job — depth,
state, or brand — and you should be able to name the job. If you cannot, it is
decoration occupying the most valuable real estate on the page.

### The all-caps eyebrow

**Trait:** a small caps label above every heading, at a size and colour chosen
to look like furniture.

**Why:** the pattern is everywhere and it signals "designed".

**Alternative:** a label earns its place only when it names something the
heading does not. `BILLING` above `Payment method` is doing work. `OVERVIEW`
above `Your projects` is restating the heading one level up in smaller type, and
it should be deleted. The restraint rule below applies here as much as anywhere:
one or two eyebrow labels in a view, not one per section.

### The accented word in a headline

**Trait:** one word of a headline set in a different colour or weight, with
nothing in the content that makes that word more important than its neighbours.

**Why:** accent is the cheapest way to make a headline look designed, and
applying it to a word chosen at random produces emphasis on an arbitrary word.

**Alternative:** write the specific claim, and let it stand unemphasised, or
accent the word that the surrounding copy actually supports. If the emphasised
word could be swapped for any other word without the sentence changing, the
emphasis is decoration — a word in a headline is normally the most
content-dependent word in the sentence, which means the sentence is too vague to
accent.

### The middot slogan

**Trait:** `Fast · Simple · Secure`, `Built for teams · Trusted by thousands`,
three or more adjectives separated by middots.

**Why:** it is the compressed form of a value proposition, and it compresses
away the claim.

**Alternative:** pick the one property that is actually true of this product and
demonstrate it, or state the claim in a sentence a customer could disagree with.
Three adjectives with separators between them cannot be wrong, which is exactly
the problem — nothing distinguishes this from any other product's slogan.

### The trailing arrow

**Trait:** `→` after link text, on every link, everywhere: `Learn more →`,
`Read the docs →`, `View all →`.

**Why:** it is a default affordance for "this goes somewhere", learned from
patterns where the destination genuinely is unknown.

**Alternative:** the link text should name its destination — `Pricing`,
`Our status page`, `Delete this project`. An arrow is worth having where the
link's *effect* is the information (opening in a new tab, leaving the site) and
worth deleting where the text already says where it goes. On a page where every
link has an arrow, the arrow has stopped carrying meaning and is now competing
with the link text for attention.

### The gratuitous type label

**Trait:** a small caps or grey label sitting above a block of content that
already has a heading, a title, or an obvious purpose. `OVERVIEW` above a
paragraph, `YOUR WORKSPACE` above a list headed `Projects`, `CURRENT PLAN` above
a price.

**Why:** a label is a strong device for naming a field, so it gets used
decoratively wherever a little space needs filling.

**Alternative:** labels are for fields and for sections whose name is doing
disambiguation work. If the block has a heading, the heading is the label, and
the extra one is competing with it. Reserve the device for a field whose name
cannot be expressed by the value beside it.

### Emoji as interface icon

**Trait:** a glyph from the emoji font standing in for a control, a status, or
the app's own identity.

**Why:** it is present in the encoding and needs no asset.

**Alternative:** text where text works, and a real icon from a set with a single
weight and style if it does not. Emoji render differently per platform, carry no
accessible name by default, and shift colour and baseline between systems — a
status that means "one thing" on a laptop and "a slightly different thing" on a
phone is a state bug wearing a costume.

## Typography tells: a scan for a draft

These are the marks to look for when reading a draft critically. They are
listed separately from the catalogue because they are cheap to check and
frequently survive a rewrite — copy changes more often than styling does.

- **One accented word in a headline** where the rest of the sentence is
  interchangeable with it.
- **All-caps labels** above more than one or two headings in a view.
- **A type label above content that already has a heading**, and a second
  heading level used to say the same thing again.
- **Middot-separated adjective runs** — `A · B · C` — in a hero, a feature list,
  or a card subtitle.
- **An arrow on every link**, and especially on links whose text already names
  the destination.
- **Two or three typefaces**, or a typeface plus a wide letter-spaced small-caps
  treatment standing in for a second typeface.
- **Sentence case in the body and Title Case in every heading**, which is a
  signal that headings were written to be looked at rather than read.

## Structure as information versus structure as decoration

Numbered markers are a claim: *this has an order, and the order is the order.*
That claim is often false, and it is expensive when it is, because a reader
confronted with `1.` on the first of four unordered items will look for the
reason that one comes first.

**The test:** could a reader reorder these four items without losing anything?
If yes, they are a set. Render them as an unordered list, or as a grid, and drop
the numbers — a numbered set spends the reader's attention on an ordering that
does not exist.

If reordering *would* lose something — the reader must know what comes after
step two, or a process has a genuine sequence and the sequence is the content —
then the numbers are information and removing them costs the reader. An install
wizard, a runbook, a pipeline with real dependencies, an argument that turns on
one step preceding another: all of these are sequences, and numbering is the
correct and cheapest way to carry that.

The same distinction applies to the other structural devices. A grid says "these
are peers". A stack says "these are related, in this importance order". A divider
says "a boundary here is real". A tab bar says "these are alternatives, and only
one is live". Every one of those is a claim about the content, and like the
numbers, it is worth checking that the content agrees.

## Spend your boldness in exactly one place

Hierarchy is a budget, and boldness has several currencies: weight, size, colour,
shadow, and space. They all draw on the same account, and the account does not
increase when you spend more of them at once.

A page that is entirely bold is a page with no reading order. The reader scans,
finds nothing that stands out, and reads all of it at the same weight — which is
the functional equivalent of not having highlighted anything, except that the
highlighting has now also made everything harder to look at.

**Spend it once.** Choose the single place on the screen where the reader's
attention should land, and let everything else be plain enough that the choice
is visible from across the room. Usually that is the primary action, or the one
number that the page exists to communicate. Not both.

The corollary is that the second-most-prominent thing is a decision too. If the
primary action is a filled button, the secondary should be a bordered one, not a
bordered one plus a slightly different grey. Rank the elements, then let the
ranking be visible in the styling, monotonically, all the way down. A page where
everything is medium is a page where the primary action is medium.

## Using this in a design brief

This is a catalogue of observations, not a house style, and it should not be
applied to an interface that already has a working system — the existing
pattern wins, and consistency inside a product beats any individual opinion
about it. It earns its place when you are making a first decision, or when
draft output has the recognisable convergence signature.

When a trait shows up in something you are writing up, it belongs in the brief
rather than in a later fix:

- **Direction** is where the alternative goes. "The set is separated by a rule
  and grouped under one heading; the recommended plan is elevated with a border
  and a label, and the others are not" — that is a decision a coder can build.
- **Rationale** is where the rejected option is named, and the rejected option
  is usually the convergent one. "Not a card grid, because the three plans are
  not equivalent and equal presentation would misrepresent the middle one."
- **Constraints** is where it becomes enforceable: "radius is reserved for
  nesting depth and is not applied uniformly", "shadow appears only on the
  popover and the sticky header".
- **Open questions** is where it belongs when you cannot decide — "the accent
  colour on the primary action is unclear because the brand palette has two
  candidates; either would work and the choice is not mine to make."
