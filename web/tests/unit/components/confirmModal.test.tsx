// @vitest-environment jsdom
/** W1 gate: typed variant arms confirm only on exact name match. */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmModal } from '../../../src/components/ConfirmModal'

function setup(typedName?: string) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConfirmModal
      open
      title="Remove agent"
      body="The workspace is preserved."
      confirmLabel="Remove"
      typedName={typedName}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  )
  return { onConfirm, onCancel }
}

describe('ConfirmModal', () => {
  it('keeps confirm disabled until the exact name is typed', () => {
    const { onConfirm } = setup('my-agent')
    const confirm = screen.getByTestId('confirm-modal-confirm-button')
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('confirm-modal-name-input'), {
      target: { value: 'my-agen' },
    })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByTestId('confirm-modal-name-input'), {
      target: { value: 'my-agent' },
    })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('my-agent')
  })

  it('simple variant is armed immediately', () => {
    const { onConfirm } = setup(undefined)
    fireEvent.click(screen.getByTestId('confirm-modal-confirm-button'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('cancel and Escape both dismiss', () => {
    const { onCancel } = setup('x')
    fireEvent.click(screen.getByTestId('confirm-modal-cancel-button'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
