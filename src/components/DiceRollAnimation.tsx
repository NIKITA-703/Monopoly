import { useState, type CSSProperties } from 'react'
import './DiceRollAnimation.css'

// Для быстрого отключения анимации достаточно поменять значение на false.
export const diceRollAnimationEnabled = true
export const diceRollAnimationDuration = 2600

const pipPositions: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
}

const finalRotation: Record<number, { x: string; y: string }> = {
  1: { x: '0deg', y: '0deg' },
  2: { x: '-90deg', y: '0deg' },
  3: { x: '0deg', y: '-90deg' },
  4: { x: '0deg', y: '90deg' },
  5: { x: '90deg', y: '0deg' },
  6: { x: '0deg', y: '-180deg' },
}

const DiceFace = ({ value }: { value: number }) => (
  <span className={`animated-die-face face-${value}`}>
    {Array.from({ length: 9 }, (_, index) => (
      <i className={pipPositions[value].includes(index + 1) ? 'visible' : ''} key={index} />
    ))}
  </span>
)

const AnimatedDie = ({ value, index }: { value: number; index: number }) => {
  const rotation = finalRotation[value] ?? finalRotation[1]
  const style = {
    '--dice-final-x': rotation.x,
    '--dice-final-y': rotation.y,
  } as CSSProperties

  return (
    <span className={`animated-die throw-${index + 1}`}>
      <span className="animated-die-cube" style={style}>
        {[1, 2, 3, 4, 5, 6].map((face) => <DiceFace value={face} key={face} />)}
      </span>
    </span>
  )
}

type DiceRollAnimationProps = {
  values: [number, number]
}

export default function DiceRollAnimation({ values }: DiceRollAnimationProps) {
  const [animationVariant] = useState(() => Math.floor(Math.random() * 6) + 1)

  if (!diceRollAnimationEnabled) return null

  return (
    <div
      className={`dice-roll-animation dice-animation-variant-${animationVariant}`}
      aria-hidden="true"
      style={{ '--dice-animation-duration': `${diceRollAnimationDuration}ms` } as CSSProperties}
    >
      <div className="dice-roll-shadow" />
      <AnimatedDie value={values[0]} index={0} />
      <AnimatedDie value={values[1]} index={1} />
    </div>
  )
}
