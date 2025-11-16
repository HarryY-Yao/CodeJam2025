# PictionAIry

## Inspiration
We wanted to reimagine Pictionary charades for a world where you don't even need a pen, paper, tablet, or even people to be creative. With PictionAIry, players draw **in the air** using only their hands and a webcam. We were inspired by the evolution of human-computer interaction and the idea of bridging physical movement with digital creativity in a low-barrier, accessible way, which means no stylus, VR headset, or special hardware required. 

## What it does
PictionAIry is a multiplayer, browser-based party game where:
- Players join a room via code and take turns drawing in the air.
- Hand gestures (index finger, open palm, OK sign) control drawing, erasing, and color changes.
- Other players guess in a chat box as the drawing appears on a shared canvas.
- Hosts can add an **AI Bot** with Easy/Medium/Hard difficulty. The AI can:
  - Draw a word stroke-by-stroke on the shared canvas, or  
  - Join as a guesser and try to identify the drawing based on the revealed word pattern.
Scores are tracked across multiple rounds, and a final leaderboard is shown at the end.

## How we built it
On the front end, we utilized HTML, CSS, and vanilla JavaScript to construct a single-page game UI featuring separate views for the lobby, game, and end screen. MediaPipe Hands and WebRTC enable real-time hand-tracking from the webcam. We interpret key landmarks to detect gestures for drawing, erasing, and color switching, then render strokes to an HTML.

On the back end, a Node.js + Express server hosts the game and static files. Socket.IO manages real-time communication, including room creation/joining, chat messages, score updates, round timers, and synced drawing events. We designed an AI module that:
- Generates template stroke sequences for each word (so the AI "draws" in our visual style).
- Tracks stroke history and masked letters.
- Uses difficulty-dependent logic to randomly guess at first, then progressively becomes more intelligent as more information is revealed.

## Challenges we ran into
- **Gesture robustness:** Getting MediaPipe gesture thresholds right so drawing feels responsive without accidental strokes was tricky, especially under different lighting conditions.
- **Canvas sync:** Ensuring every client sees the same drawing in real time required careful structuring of draw/erase events and dealing with network latency.
- **AI behavior tuning:** Making the AI feel fun and fair-sometimes silly, sometimes bright-meant iterating on how often it is allowed to guess, how "bad" the early guesses should be, and when it's allowed to be super intelligent and lock onto the correct word.
- **Game flow & roles:** Handling edge cases like players leaving mid-round, the host disconnecting, or an AI being the drawer required additional state management on the server.

## Accomplishments that we're proud of
- Building a fully working **air-gesture Pictionary** experience that runs entirely in the browser.
- Designing a distinctive visual drawing style for the AI templates (e.g., dotted outlines, simple geometric icons) and making the AI draw them stroke-by-stroke.
- Implementing an AI opponent that can both **draw** and **guess**, with adjustable difficulty levels and believable behavior rather than random spam.
- Creating a polished lobby, round system, scoreboard, and end-of-game summary that make it feel like a complete party game, not just a tech demo.

## What we learned
- How to integrate MediaPipe Hands into a real-time multiplayer setting and translate raw hand landmarks into intuitive gestures suitable for games.
- Best practices for structuring Socket.IO rooms, events, and shared state so that timers, roles, and scores remain consistent for everyone.
- Techniques for "game AI" that don't rely on heavy ML—combining heuristics, word-pattern matching, and controlled randomness to produce human-like behavior.
- The importance of UX details (clear instructions, visual feedback, and a consistent art style) when introducing a novel input mode like air-drawing.

## What's next for PictionAIry
- **Smarter AI & ML:** Train a model on real player drawings so the AI can learn to recognize shapes directly from stroke data and adapt to each player's style over time.
- **Custom word packs & themes:** Allow hosts to upload or select themed word lists (e.g., movies, school subjects, company in-jokes).
- **Accessibility & modes:** Add options like larger UI, higher contrast colors, and alternative controls for players who can't use hand gestures.
- **Online rooms at scale:** Deploy a persistent hosted version so anyone can spin up a room instantly with friends, classrooms, or remote teams.
