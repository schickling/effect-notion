import React, { useCallback, useState } from 'react'
import type { FC, ReactNode } from 'react'

import { useStyles } from '../styles/index.tsx'

const EMPTY_BORDER_STYLE: React.CSSProperties = Object.freeze({})

const SortIconContainer: FC<{ children: ReactNode }> = (props) => (
  <div
    style={{
      position: 'absolute',
      top: 1,
      right: 0,
      bottom: 1,
      display: 'flex',
      alignItems: 'center',
    }}
  >
    {props.children}
  </div>
)

const SortIcon: FC<{ sortAscending: boolean }> = ({ sortAscending }) => {
  const styles = useStyles('TableInspectorSortIcon')
  const glyph = sortAscending === true ? '▲' : '▼'
  return <div style={styles}>{glyph}</div>
}

export const TH: FC<{
  sortAscending?: boolean
  sorted?: boolean
  onClick?: (() => void) | undefined
  borderStyle?: React.CSSProperties
  children?: ReactNode
}> = ({
  sortAscending = false,
  sorted = false,
  onClick = undefined,
  borderStyle = EMPTY_BORDER_STYLE,
  children,
}) => {
  const styles = useStyles('TableInspectorTH')
  const [hovered, setHovered] = useState(false)

  const handleMouseEnter = useCallback(() => setHovered(true), [])
  const handleMouseLeave = useCallback(() => setHovered(false), [])

  return (
    <th
      style={{
        ...styles.base,
        ...borderStyle,
        ...(hovered === true ? styles.base[':hover'] : {}),
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      <div style={styles.div}>{children}</div>
      {sorted === true && (
        <SortIconContainer>
          <SortIcon sortAscending={sortAscending} />
        </SortIconContainer>
      )}
    </th>
  )
}
