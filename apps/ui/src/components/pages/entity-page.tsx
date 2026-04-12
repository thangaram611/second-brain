import { useParams } from 'react-router';
import { EntityDetail } from '../entity/entity-detail.js';

export function EntityPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;

  return <EntityDetail entityId={id} />;
}
