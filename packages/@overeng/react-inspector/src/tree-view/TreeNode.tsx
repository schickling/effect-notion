import React, { Children, memo } from 'react'
import type { FC } from 'react'

import { useStyles } from '../styles/index.tsx'

const Arrow: FC<any> = ({ expanded, styles }) => (
  <span
    style={{
      ...styles.base,
      ...(expanded === true ? styles.expanded : styles.collapsed),
    }}
  >
    ▶
  </span>
)

const DefaultNodeRenderer: FC<any> = ({ name }) => <span>{name}</span>

export const TreeNode: FC<any> = memo((props) => {
  props = {
    expanded: true,
    nodeRenderer: DefaultNodeRenderer,
    onClick: () => {},
    shouldShowArrow: false,
    shouldShowPlaceholder: true,
    ...props,
  }
  const {
    expanded,
    onClick,
    children,
    nodeRenderer,
    title,
    shouldShowArrow,
    shouldShowPlaceholder,
  } = props

  const styles = useStyles('TreeNode')
  const NodeRenderer = nodeRenderer

  return (
    <li aria-expanded={expanded} role="treeitem" style={styles.treeNodeBase} title={title}>
      <div style={styles.treeNodePreviewContainer} onClick={onClick}>
        {shouldShowArrow === true || Children.count(children) > 0 ? (
          <Arrow expanded={expanded} styles={styles.treeNodeArrow} />
        ) : (
          shouldShowPlaceholder === true && <span style={styles.treeNodePlaceholder}>&nbsp;</span>
        )}
        <NodeRenderer {...props} />
      </div>

      <ol role="group" style={styles.treeNodeChildNodesContainer}>
        {expanded === true ? children : undefined}
      </ol>
    </li>
  )
})

// TreeNode.propTypes = {
//   name: PropTypes.string,
//   data: PropTypes.any,
//   expanded: PropTypes.bool,
//   shouldShowArrow: PropTypes.bool,
//   shouldShowPlaceholder: PropTypes.bool,
//   nodeRenderer: PropTypes.func,
//   onClick: PropTypes.func,
// };
