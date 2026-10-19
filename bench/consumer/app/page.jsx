'use client'

import { useEffect } from 'react'

export default function Consumer() {
  useEffect(() => {
    void import('../compat')
  }, [])
  return (
    <>
      <canvas id="scene" width="240" height="160" />
      <canvas id="dice" width="320" height="180" />
    </>
  )
}
