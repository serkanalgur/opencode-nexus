---
name: nexus-interface-a11y
description: Concrete WCAG 2.2 AA thresholds to write into a design direction so a coder implements them rather than discovering them — 4.5:1 text contrast and 3:1 for large text, 3:1 for control and focus indication, 24x24 CSS px target size with its five exceptions, 44x44 as the stronger aim, colour never the only signal, and what prefers-reduced-motion actually obliges. Load this when specifying, building, or changing any interface a person reads, taps, focuses, or navigates.
---

# Accessibility as design decisions

Accessibility is not a pass at the end and not a list of defects to triage. Each
requirement below is a decision that changes what you specify, and specifying it
is far cheaper than retrofitting it — a contrast ratio cannot be added to an
existing palette after the fact, and a target size cannot be added to a layout
whose neighbours are already 20px apart.

The numbers are WCAG 2.2. Every one carries its success criterion so it can be
checked against the spec rather than trusted, and the levels are stated because
the difference between AA and AAA is the difference between a requirement and a
recommendation.

Two habits carry most of the value:

- **Name the number in the direction, not the principle.** "Ensure adequate
  contrast" cannot be implemented or checked. "Body text on the surface is
  #1A1A1A on #FFFFFF, 16.4:1, and the muted secondary text is #5C5C5C at
  7.0:1" can.
- **Decide it once, in the brief.** A threshold decided at implementation time
  gets decided differently in every component.

## Contrast

**Body text — 4.5:1 (SC 1.4.3, AA).** The visual presentation of text needs a
contrast ratio of at least 4.5:1 against its background. This covers placeholder
text and text shown on hover or keyboard focus, not only settled body copy.

**Large text — 3:1 (SC 1.4.3, AA).** "Large scale" is defined as at least 18pt,
or 14pt bold. At the specified ratio of 1pt = 1.333px that is **24px**, or
**18.66px bold**. The threshold is 3:1, not 4.5:1.

**Do not round.** The spec is explicit that these are thresholds, not values to
be approached: 4.499:1 does not meet 4.5:1. When a token sits just under, it
fails — pick the next one up.

**No requirement** for text in an inactive component, purely decorative text,
logotypes, and incidental text in a picture. "Inactive" means visible but not
currently operable, such as a submit button that cannot be activated until the
form is valid.

**7:1 for body text and 4.5:1 for large text is SC 1.4.6, AAA.** Worth knowing
and worth exceeding for the primary reading surface of a product, but it is not
the AA bar, and describing it as one would be wrong.

## Controls, icons, and graphical objects

**3:1 against adjacent colours (SC 1.4.11, AA).** This is the requirement most
often missed, and it is not about text at all. It covers:

- the visual information needed to **identify a user interface component** —
  its border, its fill, its icon
- the visual information needed to **identify its state** — including that it is
  focused, selected, checked, or expanded
- parts of **graphics required to understand the content**

Three consequences that change design decisions:

1. **A focus indicator needs 3:1 against its background.** This is where the
   AA-level requirement for focus contrast actually comes from — see below.
2. **A control with visible content does not need a border.** If the button has
   a label or a sufficiently contrasting icon, there is nothing to detect and no
   boundary is required. Do not add hairlines to controls that are already
   identifiable; that is a real cost in visual noise and it buys nothing.
3. **A border must be checked against the colour next to it, not its own fill.**
   For a white input on a white page, the border is measured against the white
   outside it.

**Not required:** inactive components, appearance determined by the user agent
and unmodified by the author, and presentations essential to the information
(logos, flags, a diagram that depends on its own colours).

## Focus

Three separate requirements, frequently conflated. The distinction is worth
keeping straight because they have different levels and different numbers.

**Visible indicator (SC 2.4.7, AA).** Any keyboard-operable interface has a
mode of operation where the focus indicator is visible. This sets **no
contrast number and no size** — it is a visibility requirement, and it is the
one most often satisfied accidentally, by the user agent's default outline,
which the author then removes in a `outline: none` rule. That single declaration
breaks 2.4.7 with nothing else in the stylesheet changing.

**Not entirely hidden (SC 2.4.11, AA, new in 2.2).** When a component receives
keyboard focus, author-created content must not hide it *entirely*. The
canonical failure is a sticky header that covers the row the user just tabbed
to: the element is focused, it exists, and the reader cannot see it. This is a
layout decision — scroll margin, or a header that does not overlap content, or
padding that accounts for it.

**Area and contrast (SC 2.4.13, AAA).** Where the indicator is visible, an area
of it must be at least as large as a 2 CSS pixel thick perimeter of the
unfocused component, and must have a contrast ratio of at least 3:1 between the
same pixels focused and unfocused. This is AAA, and the honest way to deploy it
is as a target rather than a requirement: an outline offset by 2px with a 2px
width clears it comfortably, and `box-shadow` spread is easier to get right
than a perimeter that has to survive rounded corners.

So: at AA, a visible focus indicator plus 3:1 against adjacent colours from
1.4.11, and nothing may cover it entirely. At AAA, a specific area and a
focused-vs-unfocused ratio.

## Target size

**24 by 24 CSS pixels (SC 2.5.8, AA, new in 2.2).** The size of the target for
pointer inputs must be at least 24 × 24 CSS pixels — it must be possible to draw
a solid 24 × 24 square aligned to the axes, fully inside the target. The
requirement is independent of zoom: users zooming in does not change CSS pixel
sizes, so it cannot be met by arguing the control will be big enough once
zoomed.

**Five exceptions, and the first is the one that actually gets used:**

- **Spacing** — an undersized target passes if a 24px-diameter circle centred on
  its bounding box does not intersect another target, or another undersized
  target's circle. A 20px control in a row with 4px of space between it and its
  neighbour passes; the same 20px control touching its neighbour fails. This is
  how dense icon rows are made compliant, and it is a spacing decision made in
  the layout, not a size decision made in the component.
- **Equivalent** — another control on the same page achieves the same function
  and meets the criterion.
- **Inline** — the target is in a sentence, or its size is otherwise constrained
  by the line-height of surrounding text. Links inside a paragraph are excepted,
  which is why inline link targets are not a 24px problem.
- **User agent control** — the size is set by the user agent and the author did
  not modify it. A default scrollbar is excepted; a restyled one is not.
- **Essential** — a particular presentation is essential to the information.
  Map pins, whose position *is* the data. The spec encourages providing an
  alternative in practice.

**44 by 44 CSS pixels is SC 2.5.5, AAA.** It is not the AA minimum and should
not be described as one. It is nonetheless the number to aim at on touch: 24px
is the floor a failure occurs at, and the AA criterion explicitly notes that
meeting the size is best practice regardless of whether spacing rescues you.

**Overlapping areas** do not count toward target size unless the overlapping
targets perform the same action.

## Colour must not be the only signal

**SC 1.4.1, Level A.** Colour is not used as the only visual means of conveying
information, indicating an action, prompting a response, or distinguishing a
visual element.

This is the requirement with the widest blast radius, because it is level A and
because it is a design decision rather than a number. In practice:

- An error state is red **and** says what is wrong. A red border alone is a
  colour-only signal, and it is also the state most likely to be checked.
- Required fields are marked in text or with a shape, not only with an asterisk
  colour. An asterisk alone needs a key, and the key needs to be findable.
- A chart's series are distinguishable by label, marker shape, or direct
  labelling, not by hue alone. If the chart is a rainbow, it is only accessible
  if the legend survives being printed in greyscale.
- A star rating that fills with colour and outlines otherwise is a hue-only
  signal and fails 1.4.1; adding a border weight difference is the usual fix.

A useful corollary when specifying: a 3:1 contrast ratio is **not** a defence.
Sufficient luminance contrast between a link and surrounding text is treated as
satisfying 1.4.1, because a difference in lightness is a non-colour signal. A
different hue at the same lightness is not.

## Motion

Be precise here, because the requirement is widely misstated.

**`prefers-reduced-motion` is not a WCAG success criterion.** It is a media
feature defined in CSS Media Queries Level 5, broadly available since 2020, and
it reports a user preference set in the operating system. Honouring it is the
mechanism, not the obligation.

The obligations are:

- **SC 2.3.3, AAA** — motion animation triggered by interaction can be disabled,
  unless the animation is essential to the functionality or the information.
- **SC 2.2.2, A** — moving, blinking, scrolling or auto-updating information that
  starts automatically, lasts more than five seconds, and is presented in
  parallel with other content has a mechanism to pause, stop or hide it.

So there is no AA-level "reduced motion" criterion, and a brief that says
"WCAG requires reduced motion support" is wrong in its citation even though its
recommendation is sound.

What honouring the preference obliges in a design direction: remove or shorten
**large-scale transforms and parallax**, which are the vestibular triggers;
halt **infinite rotation and scaling loops**; stop **auto-advancing carousels**,
which also engage 2.2.2. **Opacity and colour fades are generally not
triggers** and are usually safe to keep — a blanket "no animation" rule discards
the transition that communicates a state change, which is often load-bearing for
comprehension. A duration or easing change is a better answer than deletion.

## Zoom and reflow

**200% text resize without loss of content or functionality (SC 1.4.4, AA)**,
and **no two-dimensional scrolling at 320 CSS pixels width for vertical content
(SC 1.4.10, AA)**. 320px is equivalent to a 1280px viewport at 400% zoom.

**SC 1.4.12, AA** is the one that most often constrains a layout without anyone
noticing it: no loss of content or functionality when line height is set to at
least 1.5× the font size, paragraph spacing to at least 2×, letter spacing to at
least 0.12×, and word spacing to at least 0.16×. The consequence for design is
direct — **fixed heights on text containers clip**, so a text box sized in
absolute pixels is a defect the moment someone changes their browser's default
font size. Specify minimum heights, or no height at all.

## Where each of these belongs in a brief

- **Direction** — the palette, with the actual ratios stated; the target size;
  what the focus indicator is; what the error state shows.
- **Constraints** — the enforceable form: "no text token below 4.5:1 on any
  surface, including disabled-adjacent states"; "interactive targets 24px
  minimum, 44px on touch"; "every state difference is carried by at least one
  channel besides colour"; "no fixed heights on text containers".
- **States** — accessibility lives disproportionately in the non-happy states.
  Error, empty, loading, and disabled each need a contrast answer and a
  non-colour signal, and disabled is a contrast exemption that is easy to lean
  on by accident.
- **Open questions** — where you could not check. A real one: "the secondary
  text token is 4.3:1 on the surface, which is under 4.5:1; I have not verified
  it against the elevated card background, which is lighter and therefore worse,
  and it needs either a darker token or a decision to accept it."

## What this is not

It is not a conformance claim. Meeting these thresholds does not make an
interface accessible — an automated threshold is a floor, and the majority of
what makes an interface usable with a screen reader, a keyboard, or a switch
device is not in this document. It is also not a substitute for testing with
people. What it is: the set of decisions that, once made, make the interface
usable for a measurable number of people, and the part of accessibility that a
design direction can actually carry.

## Sources

Every figure above is from the W3C Web Content Accessibility Guidelines (WCAG)
2.2, W3C Recommendation 12 December 2024, <https://www.w3.org/TR/WCAG22/>.

- 1.4.1 Use of Color (A), 1.4.3 Contrast (Minimum) (AA), 1.4.4 Resize Text (AA),
  1.4.6 Contrast (Enhanced) (AAA), 1.4.10 Reflow (AA), 1.4.11 Non-text Contrast
  (AA), 1.4.12 Text Spacing (AA) — <https://www.w3.org/TR/WCAG22/>
- 2.2.2 Pause, Stop, Hide (A), 2.3.3 Animation from Interactions (AAA),
  2.4.7 Focus Visible (AA), 2.4.11 Focus Not Obscured (Minimum) (AA),
  2.4.13 Focus Appearance (AAA), 2.5.5 Target Size (Enhanced) (AAA),
  2.5.8 Target Size (Minimum) (AA) — <https://www.w3.org/TR/WCAG22/>
- Large-scale text definition and the "do not round" guidance, and the
  24px-diameter spacing circle, are from the Understanding documents:
  <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html> and
  <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>
- `prefers-reduced-motion` is a CSS Media Queries Level 5 media feature, not a
  WCAG criterion: <https://developer.mozilla.org/docs/Web/CSS/@media/prefers-reduced-motion>
