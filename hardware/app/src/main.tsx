import { createRoot } from "react-dom/client"
import { MotionConfig } from "motion/react"
import App from "./App"
import "./styles.css"
import "./shell.css"

createRoot(document.getElementById("root")!).render(
  <MotionConfig reducedMotion="user">
    <App />
  </MotionConfig>,
)
